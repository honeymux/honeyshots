import type { ImageTheme, RenderImageOptions } from "ghostty-opentui/image";

import { PersistentTerminal, type TerminalData } from "ghostty-opentui";

import { renderTerminalToImage } from "../core/render-terminal-to-image.ts";
import { type TerminalCropRect, cropTerminalData } from "../core/terminal-data-crop.ts";
import { type MarkerFrame, type MarkerRegion, MarkerStreamParser } from "../opentui/marker-protocol.ts";
import { ProbeResponder } from "./probe-responder.ts";

export interface ShootOptions extends RenderImageOptions {
  /**
   * Shorthand: the effective terminal background color for this shot.
   * When set, honeyshots:
   *   - uses this color for the render frame/border (frameColor),
   *   - uses this color for {@link ShootOptions.theme.background},
   *   - finds the dominant explicit `bg` in the captured frame (the color
   *     the running TUI paints on "empty" cells) and remaps it to this
   *     color, so callers don't need to know what the TUI's theme chose.
   * More targeted control is still available via {@link remapBg}.
   */
  bgColor?: string;
  /** If set, pad the image by this many CSS pixels of frame color. */
  border?: number;
  /**
   * Per-color remapping applied to every span before rendering. Keys are
   * hex strings (case-insensitive) matching a span's `bg`; values are the
   * replacement color. Overrides any implicit {@link bgColor} remap for
   * matching source colors.
   */
  remapBg?: Record<string, string>;
  /** Theme used for the captured image. */
  theme?: ImageTheme;
}

export interface TuiHarnessOptions {
  /** Command and argument vector to spawn. */
  argv: string[];
  /** Columns for the PTY. */
  cols: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Forward the child's stdout to process.stderr for debugging. */
  debug?: boolean;
  /** Environment overrides. HONEYSHOTS=1 is always set. */
  env?: Record<string, string>;
  /** Rows for the PTY. */
  rows: number;
}

/**
 * Spawns a TUI child process inside a Bun PTY, streams its output into a
 * ghostty terminal buffer for accurate capture, intercepts honeyshots region
 * markers, and exposes high-level shoot() / waitForRegion() helpers.
 */
export class TuiHarness {
  readonly cols: number;
  readonly rows: number;

  private exitCode: null | number = null;
  private frameWaiters: Array<(frame: MarkerFrame) => void> = [];
  private lastOutputAt = Date.now();
  private readonly options: TuiHarnessOptions;
  private readonly parser = new MarkerStreamParser();

  private proc: Bun.Subprocess | null = null;
  private readonly regions = new Map<string, MarkerRegion>();
  private readonly responder: ProbeResponder;
  private readonly terminal: PersistentTerminal;

  constructor(options: TuiHarnessOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.options = options;
    this.terminal = new PersistentTerminal({ cols: options.cols, rows: options.rows });
    this.responder = new ProbeResponder((data) => {
      this.proc?.terminal?.write(data);
    });
  }

  /** Current rendered terminal snapshot. */
  captureData(): TerminalData {
    const raw = this.terminal.getJson();
    return {
      ...raw,
      cursor: [0, 0] as [number, number],
      cursorVisible: false,
    };
  }

  /** Kill the child and free resources. */
  async close(): Promise<void> {
    try {
      this.proc?.kill();
    } catch {}
    try {
      await Promise.race([this.proc?.exited ?? Promise.resolve(0), sleep(1_000)]);
    } catch {}
    this.terminal.destroy();
  }

  /** Look up a single region by name and optional index. */
  getRegion(name: string, nth?: number): MarkerRegion | undefined {
    return this.regions.get(this.regionKey(name, nth));
  }

  /** Known regions. Refreshed each time the app emits a marker frame. */
  listRegions(): MarkerRegion[] {
    return [...this.regions.values()].filter(
      (r, i, arr) => arr.findIndex((x) => x.name === r.name && (x.nth ?? 0) === (r.nth ?? 0)) === i,
    );
  }

  /** Current flattened screen text (for waitForText-style matching). */
  screenText(): string {
    return this.terminal.getText();
  }

  /** Send raw input bytes to the child's PTY. */
  send(data: Buffer | string): void {
    this.assertRunning();
    if (typeof data === "string") {
      this.proc?.terminal?.write(data);
    } else {
      this.proc?.terminal?.write(data.toString("binary"));
    }
  }

  /**
   * Capture the current terminal state, crop to a named region (or the full
   * screen), and render to a PNG file.
   */
  async shoot(region: null | string, outPath: string, options: ShootOptions = {}): Promise<void> {
    const png = await this.shootBuffer(region, options);
    await Bun.write(outPath, png);
  }

  /** Variant of {@link shoot} that returns the PNG bytes instead of writing. */
  async shootBuffer(region: null | string, options: ShootOptions = {}): Promise<Buffer> {
    const full = this.captureData();
    const rect = this.resolveRect(region, full);
    const cropped = rectMatchesFull(rect, full) ? full : cropTerminalData(full, rect);

    const { bgColor, border, remapBg, theme, ...rest } = options;
    const effectiveRemap: Record<string, string> = {};
    if (bgColor) {
      const dominant = dominantBackgroundColor(cropped);
      if (dominant) effectiveRemap[dominant] = bgColor;
    }
    if (remapBg) Object.assign(effectiveRemap, remapBg);

    const data = Object.keys(effectiveRemap).length > 0 ? remapBackgrounds(cropped, effectiveRemap) : cropped;

    const resolved: Parameters<typeof renderTerminalToImage>[1] = { ...rest };
    if (theme) {
      resolved.theme = theme;
    } else if (bgColor) {
      resolved.theme = { background: bgColor, text: "#cccccc" };
    }
    if (bgColor && resolved.frameColor === undefined) {
      resolved.frameColor = bgColor;
    }
    const hasBorder = typeof border === "number" && border > 0;
    if (hasBorder) {
      resolved.paddingX = border;
      resolved.paddingY = border;
    }
    return renderTerminalToImage(data, resolved);
  }

  /** Spawn the child process. Does not wait for any particular state. */
  async start(): Promise<void> {
    if (this.proc) {
      throw new Error("TuiHarness already started");
    }
    const env: Record<string, string> = {
      ...(this.options.env ?? {}),
      HONEYSHOTS: "1",
    };
    const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
      env,
      terminal: {
        cols: this.cols,
        data: (_term, chunk) => this.handleOutput(Buffer.from(chunk)),
        rows: this.rows,
      },
    };
    if (this.options.cwd) {
      spawnOptions.cwd = this.options.cwd;
    }
    this.proc = Bun.spawn(this.options.argv, spawnOptions);
    this.proc.exited.then((code) => {
      this.exitCode = code;
    });
  }

  /** Wait until no PTY output has arrived for {@link idleMs}. */
  async waitForIdle(idleMs = 250, timeoutMs = 6_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertRunning();
      if (Date.now() - this.lastOutputAt >= idleMs) return;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for idle output`);
  }

  /** Resolve when a region with the given name appears in a marker frame. */
  async waitForRegion(name: string, timeoutMs = 8_000): Promise<MarkerRegion> {
    const existing = this.regions.get(name);
    if (existing) return existing;
    return new Promise<MarkerRegion>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w !== handler);
        reject(new Error(`Timed out waiting for region ${JSON.stringify(name)} after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (_frame: MarkerFrame) => {
        const r = this.regions.get(name);
        if (r) {
          clearTimeout(timer);
          this.frameWaiters = this.frameWaiters.filter((w) => w !== handler);
          resolve(r);
        }
      };
      this.frameWaiters.push(handler);
    });
  }

  /** Wait for arbitrary screen text to appear. */
  async waitForText(needle: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertRunning();
      if (this.screenText().includes(needle)) return;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for text: ${JSON.stringify(needle)}`);
  }

  private applyFrame(frame: MarkerFrame): void {
    this.regions.clear();
    for (const region of frame.regions) {
      this.regions.set(this.regionKey(region.name, region.nth), region);
      if (region.nth === undefined || region.nth === 0) {
        this.regions.set(region.name, region);
      }
    }
    const waiters = this.frameWaiters.splice(0);
    for (const w of waiters) w(frame);
  }

  private assertRunning(): void {
    if (this.exitCode !== null) {
      throw new Error(`TuiHarness child exited with code ${this.exitCode}`);
    }
  }

  private handleOutput(data: Buffer): void {
    this.lastOutputAt = Date.now();
    this.responder.onOutput(data);

    const { cleaned, frames } = this.parser.push(data);
    if (cleaned.length > 0) {
      this.terminal.feed(cleaned);
      if (this.options.debug) {
        process.stderr.write(cleaned);
      }
    }
    for (const frame of frames) {
      this.applyFrame(frame);
    }
  }

  private regionKey(name: string, nth?: number): string {
    return nth === undefined ? name : `${name}#${nth}`;
  }

  private resolveRect(region: null | string, full: TerminalData): TerminalCropRect {
    if (region === null) {
      return { height: full.rows, left: 0, top: 0, width: full.cols };
    }
    const r = this.regions.get(region);
    if (!r) {
      throw new Error(`Unknown region ${JSON.stringify(region)}. Known: [${[...this.regions.keys()].join(", ")}]`);
    }
    return { height: r.h, left: r.x, top: r.y, width: r.w };
  }
}

function dominantBackgroundColor(data: TerminalData): null | string {
  const freq = new Map<string, number>();
  for (const line of data.lines) {
    for (const span of line.spans) {
      if (!span.bg) continue;
      const key = normalizeHex(span.bg);
      freq.set(key, (freq.get(key) ?? 0) + span.width);
    }
  }
  let best: null | string = null;
  let bestCount = 0;
  for (const [color, count] of freq) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function normalizeHex(color: string): string {
  return color.toLowerCase();
}

function rectMatchesFull(rect: TerminalCropRect, full: TerminalData): boolean {
  return rect.left === 0 && rect.top === 0 && rect.width === full.cols && rect.height === full.rows;
}

function remapBackgrounds(data: TerminalData, remap: Record<string, string>): TerminalData {
  const lookup = new Map<string, string>();
  for (const [from, to] of Object.entries(remap)) {
    lookup.set(normalizeHex(from), to);
  }
  if (lookup.size === 0) return data;
  const lines = data.lines.map((line) => ({
    ...line,
    spans: line.spans.map((span) => {
      if (!span.bg) return span;
      const replacement = lookup.get(normalizeHex(span.bg));
      return replacement === undefined ? span : { ...span, bg: replacement };
    }),
  }));
  return { ...data, lines };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
