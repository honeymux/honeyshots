import type { CliRenderer, OptimizedBuffer } from "@opentui/core";

import { type MarkerFrame, type MarkerRegion, encodeMarker } from "./marker-protocol.ts";
import { REGION_ID_PREFIX, readRegionTag } from "./region.tsx";

export interface InstallAdapterOptions {
  /**
   * When false (the default, inferred from `HONEYSHOTS` env var), the adapter
   * does nothing. Apps can unconditionally call {@link installAdapter} at
   * startup and only pay the cost under the honeyshots harness.
   */
  enabled?: boolean;
  /**
   * Poll interval (ms) used as a watchdog for cases where the renderer is
   * idle but regions may have moved (e.g. layout settled after a resize).
   * Set to 0 to disable. Default: 0 (rely on post-process hook).
   */
  watchdogIntervalMs?: number;
  /**
   * Destination for the OSC marker stream. Defaults to `process.stdout`.
   * The harness intercepts this from the PTY before forwarding to the
   * terminal buffer, so the markers never render on screen.
   */
  write?: (chunk: string) => void;
}

/**
 * Installs the honeyshots adapter on an OpenTUI CliRenderer. Call once at app
 * startup, after creating the renderer but before rendering.
 *
 * ```ts
 * const renderer = await createCliRenderer({...});
 * installAdapter(renderer);
 * createRoot(renderer).render(<App />);
 * ```
 *
 * Returns a disposer that removes the post-process hook. Safe to ignore.
 */
export function installAdapter(renderer: CliRenderer, options: InstallAdapterOptions = {}): () => void {
  const enabled = options.enabled ?? (typeof process !== "undefined" && process.env?.["HONEYSHOTS"] === "1");
  if (!enabled) {
    return () => {};
  }

  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  let seq = 0;
  let lastPayload = "";

  const postProcess = (_buffer: OptimizedBuffer, _deltaTime: number): void => {
    const regions = collectRegions(renderer);
    const frame: MarkerFrame = {
      regions,
      seq: seq + 1,
      t: Date.now(),
    };
    const payload = JSON.stringify({ regions: frame.regions });
    if (payload === lastPayload) return;
    lastPayload = payload;
    seq = frame.seq;
    write(encodeMarker(frame));
  };

  renderer.addPostProcessFn(postProcess);

  let watchdog: ReturnType<typeof setInterval> | null = null;
  if (options.watchdogIntervalMs && options.watchdogIntervalMs > 0) {
    watchdog = setInterval(() => postProcess(null as unknown as OptimizedBuffer, 0), options.watchdogIntervalMs);
  }

  return () => {
    renderer.removePostProcessFn(postProcess);
    if (watchdog) clearInterval(watchdog);
  };
}

/**
 * Walks the renderer's renderable tree collecting every node that was tagged
 * by {@link Region}. Returns one {@link MarkerRegion} per tagged node with
 * the node's absolute cell coordinates.
 */
function collectRegions(renderer: CliRenderer): MarkerRegion[] {
  const out: MarkerRegion[] = [];
  const seenNames = new Map<string, number>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const renderable = node as {
      getChildren?: () => unknown[];
      height?: number;
      id?: string;
      visible?: boolean;
      width?: number;
      x?: number;
      y?: number;
    };

    let tagName: null | string = null;
    let tagNth: number | undefined = undefined;

    const explicitTag = readRegionTag(renderable as Parameters<typeof readRegionTag>[0]);
    if (explicitTag) {
      tagName = explicitTag.name;
      tagNth = explicitTag.nth;
    } else if (typeof renderable.id === "string" && renderable.id.startsWith(REGION_ID_PREFIX)) {
      tagName = renderable.id.slice(REGION_ID_PREFIX.length);
    }

    if (tagName && typeof renderable.width === "number" && typeof renderable.height === "number") {
      const nameCount = seenNames.get(tagName) ?? 0;
      seenNames.set(tagName, nameCount + 1);
      const nth = tagNth ?? nameCount;
      const region: MarkerRegion = {
        h: Math.max(0, Math.floor(renderable.height)),
        name: tagName,
        w: Math.max(0, Math.floor(renderable.width)),
        x: Math.max(0, Math.floor(renderable.x ?? 0)),
        y: Math.max(0, Math.floor(renderable.y ?? 0)),
      };
      if (nth !== 0) region.nth = nth;
      out.push(region);
    }

    if (typeof renderable.getChildren === "function") {
      for (const child of renderable.getChildren()) {
        walk(child);
      }
    }
  };

  walk((renderer as unknown as { root: unknown }).root);
  return out;
}
