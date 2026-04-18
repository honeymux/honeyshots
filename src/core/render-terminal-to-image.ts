import type { ImageTheme, RenderImageOptions } from "ghostty-opentui/image";

import { StyleFlags, type TerminalData, type TerminalLine, type TerminalSpan } from "ghostty-opentui";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Use node module resolution so the paths stay valid whether the
// consumer's package manager hoists ghostty-opentui to its top-level
// node_modules or nests it under honeyshots.
const requireFromHere = createRequire(import.meta.url);
const ghosttyPublicDir = join(dirname(requireFromHere.resolve("ghostty-opentui/package.json")), "public");

const DEFAULT_THEME: ImageTheme = {
  background: "#1a1b26",
  text: "#c0caf5",
};

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_LINE_HEIGHT = 1.35;
const DEFAULT_PADDING_X = 0;
const DEFAULT_PADDING_Y = 0;
const FALLBACK_SYMBOLS_FONT_NAME = "Symbols Nerd Font Mono";
const CHAR_WIDTH_FACTOR = 0.6;
const EXTRA_FALLBACK_QUERIES = ["sans:charset=0x2317", "sans:charset=0x2692", "monospace:charset=0x2011"] as const;

interface ExtraFont {
  familyName: string;
  path: string;
}

let cachedRenderer: import("@takumi-rs/core").Renderer | null = null;
let rendererInitPromise: Promise<import("@takumi-rs/core").Renderer> | null = null;
let cachedFontPath: string | undefined = undefined;
let cachedExtraFontsPromise: Promise<ExtraFont[]> | null = null;

interface BlockFill {
  height: number;
  left: number;
  top: number;
  width: number;
}

type PowerlineShape = "halfCircleLeft" | "halfCircleRight" | "triangleLeft" | "triangleRight";

interface SubRun {
  charCount: number;
  isGeo: boolean;
  text: string;
}

export async function renderTerminalToImage(data: TerminalData, options: RenderImageOptions = {}): Promise<Buffer> {
  const helpers = await import("@takumi-rs/helpers");
  const renderer = await getRenderer(options.fontPath);
  const extraFonts = await resolveExtraFallbackFonts();

  const {
    fontSize = DEFAULT_FONT_SIZE,
    format = "png",
    height,
    lineHeight = DEFAULT_LINE_HEIGHT,
    paddingX = DEFAULT_PADDING_X,
    paddingY = DEFAULT_PADDING_Y,
    quality = 90,
  } = options;

  const imageWidth = options.width ?? calculateAutoWidth(data.cols, fontSize, paddingX);
  const lines = trimTrailingEmptyLines(data.lines);
  if (lines.length === 0) {
    throw new Error("No content to render");
  }

  const lineHeightPx = Math.round(fontSize * lineHeight);
  let visibleLines: TerminalLine[];
  let imageHeight: number;

  if (height) {
    const availableHeight = height - paddingY * 2;
    const maxLines = Math.floor(availableHeight / lineHeightPx);
    visibleLines = lines.slice(0, maxLines);
    imageHeight = height;
  } else {
    visibleLines = lines;
    imageHeight = lines.length * lineHeightPx + paddingY * 2;
  }

  const theme = options.theme ?? DEFAULT_THEME;
  const resolvedFrameColor =
    options.frameColor ?? (paddingX > 0 || paddingY > 0 ? detectEdgeColor(visibleLines, theme.background) : undefined);

  const rootOptions: { extraFonts: ExtraFont[]; imageHeight: number; imageWidth: number } & RenderImageOptions = {
    ...options,
    extraFonts,
    imageHeight,
    imageWidth,
  };
  if (resolvedFrameColor !== undefined) {
    rootOptions.frameColor = resolvedFrameColor;
  }
  const rootNode = frameToRootNode(visibleLines, helpers, rootOptions);

  const dpr = options.devicePixelRatio ?? 1;
  const imageBuffer = await renderer.render(rootNode, {
    devicePixelRatio: dpr,
    format,
    height: Math.round(imageHeight * dpr),
    quality,
    width: Math.round(imageWidth * dpr),
  });

  return Buffer.from(imageBuffer);
}

function blockElementNode(
  fill: BlockFill,
  fg: string,
  bg: null | string,
  cellWidth: number,
  cellHeight: number,
  helpers: typeof import("@takumi-rs/helpers"),
) {
  const { container } = helpers;
  return container({
    children: [
      container({
        children: [],
        style: {
          backgroundColor: fg,
          height: Math.round(fill.height * cellHeight),
          left: Math.round(fill.left * cellWidth),
          position: "absolute",
          top: Math.round(fill.top * cellHeight),
          width: Math.round(fill.width * cellWidth),
        } as any,
      }),
    ],
    style: {
      flexShrink: 0,
      height: cellHeight,
      overflow: "hidden",
      position: "relative",
      width: cellWidth,
      ...(bg ? { backgroundColor: bg } : {}),
    } as any,
  });
}

function boxDrawingCharNode(
  segments: [number, number, number, number],
  fg: string,
  bg: null | string,
  cellWidth: number,
  cellHeight: number,
  helpers: typeof import("@takumi-rs/helpers"),
) {
  const { container } = helpers;
  const [up, down, left, right] = segments;

  const lightT = Math.max(1, Math.round(cellWidth * 0.12));
  const heavyT = Math.max(2, Math.round(cellWidth * 0.24));
  const thick = (w: number) => (w === 2 ? heavyT : lightT);

  const cx = Math.floor(cellWidth / 2);
  const cy = Math.floor(cellHeight / 2);
  const children: ReturnType<typeof container>[] = [];

  if (up) {
    const t = thick(up);
    const ht = Math.floor(t / 2);
    children.push(
      container({
        children: [],
        style: {
          backgroundColor: fg,
          height: cy + ht + 1,
          left: cx - ht,
          position: "absolute",
          top: 0,
          width: t,
        } as any,
      }),
    );
  }
  if (down) {
    const t = thick(down);
    const ht = Math.floor(t / 2);
    children.push(
      container({
        children: [],
        style: {
          backgroundColor: fg,
          height: cellHeight - cy + ht,
          left: cx - ht,
          position: "absolute",
          top: cy - ht,
          width: t,
        } as any,
      }),
    );
  }
  if (left) {
    const t = thick(left);
    const ht = Math.floor(t / 2);
    children.push(
      container({
        children: [],
        style: {
          backgroundColor: fg,
          height: t,
          left: 0,
          position: "absolute",
          top: cy - ht,
          width: cx + ht + 1,
        } as any,
      }),
    );
  }
  if (right) {
    const t = thick(right);
    const ht = Math.floor(t / 2);
    children.push(
      container({
        children: [],
        style: {
          backgroundColor: fg,
          height: t,
          left: cx - ht,
          position: "absolute",
          top: cy - ht,
          width: cellWidth - cx + ht,
        } as any,
      }),
    );
  }

  return container({
    children,
    style: {
      flexShrink: 0,
      height: cellHeight,
      overflow: "hidden",
      position: "relative",
      width: cellWidth,
      ...(bg ? { backgroundColor: bg } : {}),
    } as any,
  });
}

function buildFontFamily(extraFonts: ExtraFont[]): string {
  const extraFamilies = extraFonts.map((font) => font.familyName);
  return ["JetBrains Mono Nerd", FALLBACK_SYMBOLS_FONT_NAME, ...extraFamilies, "monospace"].join(", ");
}

function calculateAutoWidth(cols: number, fontSize: number, paddingX: number): number {
  const charWidth = fontSize * CHAR_WIDTH_FACTOR;
  return Math.ceil(cols * charWidth + paddingX * 2);
}

function detectEdgeColor(lines: TerminalLine[], fallback: string): string {
  const counts = new Map<string, number>();
  const add = (color: null | string) => {
    const c = color ?? fallback;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  };

  for (let i = 0; i < lines.length; i++) {
    const spans = lines[i]!.spans;
    if (spans.length === 0) {
      add(null);
      continue;
    }
    if (i === 0 || i === lines.length - 1) {
      for (const span of spans) add(span.bg);
    } else {
      add(spans[0]!.bg);
      if (spans.length > 1) add(spans[spans.length - 1]!.bg);
    }
  }

  let best = fallback;
  let bestCount = 0;
  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function frameToRootNode(
  lines: TerminalLine[],
  helpers: typeof import("@takumi-rs/helpers"),
  options: { extraFonts: ExtraFont[]; imageHeight: number; imageWidth: number } & RenderImageOptions,
) {
  const { container } = helpers;
  const {
    extraFonts,
    fontSize = DEFAULT_FONT_SIZE,
    imageHeight,
    imageWidth,
    lineHeight = DEFAULT_LINE_HEIGHT,
    paddingX = DEFAULT_PADDING_X,
    paddingY = DEFAULT_PADDING_Y,
    theme = DEFAULT_THEME,
  } = options;

  const frameColor = options.frameColor;
  const hasFrame = (paddingX > 0 || paddingY > 0) && frameColor && frameColor !== theme.background;
  const contentWidth = imageWidth - paddingX * 2;
  const charWidth = fontSize * CHAR_WIDTH_FACTOR;
  const fontFamily = buildFontFamily(extraFonts);

  const lineNodes = lines.map((line) =>
    lineToContainerNode(line, helpers, {
      backgroundColor: theme.background,
      charWidth,
      fontSize,
      lineHeight,
      theme,
      width: contentWidth,
    }),
  );

  const children = hasFrame
    ? [
        container({
          children: lineNodes,
          style: {
            backgroundColor: theme.background,
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            flexShrink: 0,
            gap: 0,
            overflow: "hidden",
          },
        }),
      ]
    : lineNodes;

  return container({
    children,
    style: {
      backgroundColor: hasFrame ? frameColor : theme.background,
      color: theme.text,
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
      fontFamily,
      fontSize,
      gap: 0,
      height: imageHeight,
      overflow: "hidden",
      paddingBottom: paddingY,
      paddingLeft: paddingX,
      paddingRight: paddingX,
      paddingTop: paddingY,
      whiteSpace: "pre",
      width: imageWidth,
    },
  });
}

function geometricCharNode(
  codePoint: number,
  fg: string,
  bg: null | string,
  cellWidth: number,
  cellHeight: number,
  helpers: typeof import("@takumi-rs/helpers"),
) {
  const boxSegs = getBoxSegments(codePoint);
  if (boxSegs) return boxDrawingCharNode(boxSegs, fg, bg, cellWidth, cellHeight, helpers);
  const blockFill = getBlockElement(codePoint);
  if (blockFill) return blockElementNode(blockFill, fg, bg, cellWidth, cellHeight, helpers);
  const powerline = getPowerlineShape(codePoint);
  if (powerline) return powerlineCharNode(powerline, fg, bg, cellWidth, cellHeight, helpers);
  const { container } = helpers;
  return container({ children: [], style: { flexShrink: 0, height: cellHeight, width: cellWidth } as any });
}

// ---------------------------------------------------------------------------
// Geometric rendering for box-drawing, block element, and Powerline cap
// characters.
//
// All pixel positions are derived from *global* column indices
// (round(globalCol * charWidth)) so that the same terminal column always
// lands at the same pixel, regardless of how spans are split across rows.
// ---------------------------------------------------------------------------

function geometricSpanNode(
  span: TerminalSpan,
  helpers: typeof import("@takumi-rs/helpers"),
  theme: ImageTheme,
  totalWidthPx: number,
  lineHeightPx: number,
  charWidth: number,
  globalColStart: number,
) {
  const { container } = helpers;

  let fg = span.fg;
  let bg = span.bg;
  if (span.flags & StyleFlags.INVERSE) {
    const tmpFg = fg;
    fg = bg ?? theme.text;
    bg = tmpFg ?? theme.background;
  }
  const fgColor = fg ?? theme.text;

  const chars = [...span.text];
  const spanStartPx = Math.round(globalColStart * charWidth);

  let colOffset = globalColStart;
  const children = chars.map((ch) => {
    const startPx = Math.round(colOffset * charWidth) - spanStartPx;
    const endPx = Math.round((colOffset + 1) * charWidth) - spanStartPx;
    colOffset += 1;
    return geometricCharNode(ch.codePointAt(0)!, fgColor, bg, endPx - startPx, lineHeightPx, helpers);
  });

  const style: Record<string, any> = {
    display: "flex",
    flexDirection: "row",
    flexShrink: 0,
    height: "100%",
    overflow: "hidden",
    width: totalWidthPx,
  };
  if (bg) style["backgroundColor"] = bg;
  if (span.flags & StyleFlags.FAINT) style["opacity"] = 0.5;

  return container({ children, style });
}

function getBlockElement(codePoint: number): BlockFill | null {
  switch (codePoint) {
    case 0x2580:
      return { height: 0.5, left: 0, top: 0, width: 1 };
    case 0x2581:
      return { height: 1 / 8, left: 0, top: 7 / 8, width: 1 };
    case 0x2582:
      return { height: 1 / 4, left: 0, top: 3 / 4, width: 1 };
    case 0x2583:
      return { height: 3 / 8, left: 0, top: 5 / 8, width: 1 };
    case 0x2584:
      return { height: 0.5, left: 0, top: 0.5, width: 1 };
    case 0x2585:
      return { height: 5 / 8, left: 0, top: 3 / 8, width: 1 };
    case 0x2586:
      return { height: 3 / 4, left: 0, top: 1 / 4, width: 1 };
    case 0x2587:
      return { height: 7 / 8, left: 0, top: 1 / 8, width: 1 };
    case 0x2588:
      return { height: 1, left: 0, top: 0, width: 1 };
    case 0x2589:
      return { height: 1, left: 0, top: 0, width: 7 / 8 };
    case 0x258a:
      return { height: 1, left: 0, top: 0, width: 3 / 4 };
    case 0x258b:
      return { height: 1, left: 0, top: 0, width: 5 / 8 };
    case 0x258c:
      return { height: 1, left: 0, top: 0, width: 0.5 };
    case 0x258d:
      return { height: 1, left: 0, top: 0, width: 3 / 8 };
    case 0x258e:
      return { height: 1, left: 0, top: 0, width: 1 / 4 };
    case 0x258f:
      return { height: 1, left: 0, top: 0, width: 1 / 8 };
    case 0x2590:
      return { height: 1, left: 0.5, top: 0, width: 0.5 };
    default:
      return null;
  }
}

function getBoxSegments(codePoint: number): [number, number, number, number] | null {
  if (codePoint < 0x2500 || codePoint > 0x2570) return null;
  // prettier-ignore
  const TABLE: ([number, number, number, number] | null)[] = [
    /* 2500 ─ */ [0,0,1,1], /* 2501 ━ */ [0,0,2,2], /* 2502 │ */ [1,1,0,0], /* 2503 ┃ */ [2,2,0,0],
    /* 2504 ┄ */ [0,0,1,1], /* 2505 ┅ */ [0,0,2,2], /* 2506 ┆ */ [1,1,0,0], /* 2507 ┇ */ [2,2,0,0],
    /* 2508 ┈ */ [0,0,1,1], /* 2509 ┉ */ [0,0,2,2], /* 250A ┊ */ [1,1,0,0], /* 250B ┋ */ [2,2,0,0],
    /* 250C ┌ */ [0,1,0,1], /* 250D ┍ */ [0,1,0,2], /* 250E ┎ */ [0,2,0,1], /* 250F ┏ */ [0,2,0,2],
    /* 2510 ┐ */ [0,1,1,0], /* 2511 ┑ */ [0,1,2,0], /* 2512 ┒ */ [0,2,1,0], /* 2513 ┓ */ [0,2,2,0],
    /* 2514 └ */ [1,0,0,1], /* 2515 ┕ */ [1,0,0,2], /* 2516 ┖ */ [2,0,0,1], /* 2517 ┗ */ [2,0,0,2],
    /* 2518 ┘ */ [1,0,1,0], /* 2519 ┙ */ [1,0,2,0], /* 251A ┚ */ [2,0,1,0], /* 251B ┛ */ [2,0,2,0],
    /* 251C ├ */ [1,1,0,1], /* 251D ┝ */ [1,1,0,2], /* 251E ┞ */ [2,1,0,1], /* 251F ┟ */ [1,2,0,1],
    /* 2520 ┠ */ [2,2,0,1], /* 2521 ┡ */ [2,1,0,2], /* 2522 ┢ */ [1,2,0,2], /* 2523 ┣ */ [2,2,0,2],
    /* 2524 ┤ */ [1,1,1,0], /* 2525 ┥ */ [1,1,2,0], /* 2526 ┦ */ [2,1,1,0], /* 2527 ┧ */ [1,2,1,0],
    /* 2528 ┨ */ [2,2,1,0], /* 2529 ┩ */ [2,1,2,0], /* 252A ┪ */ [1,2,2,0], /* 252B ┫ */ [2,2,2,0],
    /* 252C ┬ */ [0,1,1,1], /* 252D ┭ */ [0,1,2,1], /* 252E ┮ */ [0,1,1,2], /* 252F ┯ */ [0,1,2,2],
    /* 2530 ┰ */ [0,2,1,1], /* 2531 ┱ */ [0,2,2,1], /* 2532 ┲ */ [0,2,1,2], /* 2533 ┳ */ [0,2,2,2],
    /* 2534 ┴ */ [1,0,1,1], /* 2535 ┵ */ [1,0,2,1], /* 2536 ┶ */ [1,0,1,2], /* 2537 ┷ */ [1,0,2,2],
    /* 2538 ┸ */ [2,0,1,1], /* 2539 ┹ */ [2,0,2,1], /* 253A ┺ */ [2,0,1,2], /* 253B ┻ */ [2,0,2,2],
    /* 253C ┼ */ [1,1,1,1], /* 253D ┽ */ [1,1,2,1], /* 253E ┾ */ [1,1,1,2], /* 253F ┿ */ [1,1,2,2],
    /* 2540 ╀ */ [2,1,1,1], /* 2541 ╁ */ [1,2,1,1], /* 2542 ╂ */ [2,2,1,1], /* 2543 ╃ */ [2,1,2,1],
    /* 2544 ╄ */ [2,1,1,2], /* 2545 ╅ */ [1,2,2,1], /* 2546 ╆ */ [1,2,1,2], /* 2547 ╇ */ [2,1,2,2],
    /* 2548 ╈ */ [1,2,2,2], /* 2549 ╉ */ [2,2,2,1], /* 254A ╊ */ [2,2,1,2], /* 254B ╋ */ [2,2,2,2],
    /* 254C ╌ */ [0,0,1,1], /* 254D ╍ */ [0,0,2,2], /* 254E ╎ */ [1,1,0,0], /* 254F ╏ */ [2,2,0,0],
    /* 2550 ═ */ [0,0,1,1], /* 2551 ║ */ [1,1,0,0],
    /* 2552 ╒ */ [0,1,0,1], /* 2553 ╓ */ [0,1,0,1], /* 2554 ╔ */ [0,1,0,1],
    /* 2555 ╕ */ [0,1,1,0], /* 2556 ╖ */ [0,1,1,0], /* 2557 ╗ */ [0,1,1,0],
    /* 2558 ╘ */ [1,0,0,1], /* 2559 ╙ */ [1,0,0,1], /* 255A ╚ */ [1,0,0,1],
    /* 255B ╛ */ [1,0,1,0], /* 255C ╜ */ [1,0,1,0], /* 255D ╝ */ [1,0,1,0],
    /* 255E ╞ */ [1,1,0,1], /* 255F ╟ */ [1,1,0,1], /* 2560 ╠ */ [1,1,0,1],
    /* 2561 ╡ */ [1,1,1,0], /* 2562 ╢ */ [1,1,1,0], /* 2563 ╣ */ [1,1,1,0],
    /* 2564 ╤ */ [0,1,1,1], /* 2565 ╥ */ [0,1,1,1], /* 2566 ╦ */ [0,1,1,1],
    /* 2567 ╧ */ [1,0,1,1], /* 2568 ╨ */ [1,0,1,1], /* 2569 ╩ */ [1,0,1,1],
    /* 256A ╪ */ [1,1,1,1], /* 256B ╫ */ [1,1,1,1], /* 256C ╬ */ [1,1,1,1],
    /* 256D ╭ */ [0,1,0,1], /* 256E ╮ */ [0,1,1,0], /* 256F ╯ */ [1,0,1,0], /* 2570 ╰ */ [1,0,0,1],
  ];
  const idx = codePoint - 0x2500;
  return idx < TABLE.length ? (TABLE[idx] ?? null) : null;
}

function getBundledFallbackFontPath(): string {
  return join(ghosttyPublicDir, "symbols-nerd-font-mono-regular.ttf");
}

function getBundledFontPath(): string {
  return join(ghosttyPublicDir, "jetbrains-mono-nerd.ttf");
}

function getPowerlineShape(codePoint: number): PowerlineShape | null {
  switch (codePoint) {
    case 0xe0b0:
      return "triangleRight";
    case 0xe0b2:
      return "triangleLeft";
    case 0xe0b4:
      return "halfCircleRight";
    case 0xe0b6:
      return "halfCircleLeft";
    default:
      return null;
  }
}

async function getRenderer(fontPath?: string): Promise<import("@takumi-rs/core").Renderer> {
  if (cachedRenderer && cachedFontPath === fontPath) {
    return cachedRenderer;
  }

  if (cachedFontPath !== fontPath) {
    cachedRenderer = null;
    rendererInitPromise = null;
  }

  if (rendererInitPromise) {
    return rendererInitPromise;
  }

  rendererInitPromise = (async () => {
    const { Renderer } = await import("@takumi-rs/core");
    const renderer = new Renderer();

    const resolvedFontPath = fontPath ?? getBundledFontPath();
    await renderer.loadFont(new Uint8Array(readFileSync(resolvedFontPath)));

    await renderer.loadFont({
      data: new Uint8Array(readFileSync(getBundledFallbackFontPath())),
      name: FALLBACK_SYMBOLS_FONT_NAME,
    });

    const extraFonts = await resolveExtraFallbackFonts();
    for (const font of extraFonts) {
      await renderer.loadFont({
        data: new Uint8Array(readFileSync(font.path)),
        name: font.familyName,
      });
    }

    cachedFontPath = fontPath;
    cachedRenderer = renderer;
    return renderer;
  })();

  return rendererInitPromise;
}

function hasAnyGeometric(text: string): boolean {
  for (const ch of text) {
    if (isGeometricChar(ch.codePointAt(0)!)) return true;
  }
  return false;
}

function isGeometricChar(codePoint: number): boolean {
  return (
    getBoxSegments(codePoint) !== null || getBlockElement(codePoint) !== null || getPowerlineShape(codePoint) !== null
  );
}

function isLineEmpty(line: TerminalLine): boolean {
  if (line.spans.length === 0) return true;
  return line.spans.every((span) => {
    const textEmpty = span.text.trim() === "";
    const noBg = span.bg === null;
    const noInverse = (span.flags & StyleFlags.INVERSE) === 0;
    return textEmpty && noBg && noInverse;
  });
}

function lineToContainerNode(
  line: TerminalLine,
  helpers: typeof import("@takumi-rs/helpers"),
  options: {
    backgroundColor: string;
    charWidth: number;
    fontSize: number;
    lineHeight: number;
    theme: ImageTheme;
    width?: number;
  },
) {
  const { container, text } = helpers;
  const { backgroundColor, charWidth, fontSize, lineHeight, theme, width } = options;

  const lineHeightPx = Math.round(fontSize * lineHeight);
  let accCol = 0;
  let spanChildren = line.spans.map((span) => {
    const startPx = Math.round(accCol * charWidth);
    const endPx = Math.round((accCol + span.width) * charWidth);
    const widthPx = endPx - startPx;
    const spanColStart = accCol;
    accCol += span.width;
    if (hasAnyGeometric(span.text)) {
      return renderMixedSpan(span, helpers, theme, widthPx, lineHeightPx, charWidth, spanColStart);
    }
    return spanToNode(span, helpers, theme, widthPx);
  });

  if (spanChildren.length === 0) {
    spanChildren = [
      container({
        children: [text("m", { color: backgroundColor })],
        style: { display: "flex", flexShrink: 0, height: "100%", width: 1 },
      }),
    ];
  }

  // The line background always matches the terminal background. Earlier
  // versions inherited the last span's bg on the theory that it would
  // extend a trailing highlight to the right edge, but that caused
  // non-edge spans with bg=null (the majority) to leak the last span's
  // bg color across the whole row.
  const spacer = container({
    children: [],
    style: {
      backgroundColor: backgroundColor,
      flex: 1,
      flexShrink: 0,
      height: "100%",
    },
  });

  return container({
    children: [...spanChildren, spacer],
    style: {
      alignItems: "center",
      backgroundColor: backgroundColor,
      display: "flex",
      flexDirection: "row",
      flexShrink: 0,
      height: lineHeightPx,
      overflow: "hidden",
      width: width ?? "100%",
    },
  });
}

// Powerline cap shapes (U+E0B0/B2/B4/B6) rendered as stacks of 1px horizontal
// strips so the edge tracks the cell geometry exactly, regardless of font
// metrics. Shape directions match the Powerline convention:
//
//   triangleRight (E0B0): filled left, point on right edge
//   triangleLeft  (E0B2): point on left edge, filled right
//   halfCircleRight (E0B4): diameter on left edge, curve bulging right
//   halfCircleLeft  (E0B6): curve bulging left, diameter on right edge
function powerlineCharNode(
  shape: PowerlineShape,
  fg: string,
  bg: null | string,
  cellWidth: number,
  cellHeight: number,
  helpers: typeof import("@takumi-rs/helpers"),
) {
  const { container } = helpers;

  // Half-circle caps: render as a clipped ellipse via borderRadius so the
  // curved edge gets takumi's anti-aliasing instead of the stair-step
  // pattern a pixel-strip approximation produces at this size.
  if (shape === "halfCircleLeft" || shape === "halfCircleRight") {
    // Inner ellipse is 2 cells wide by 1 cell tall, centered on the edge
    // adjacent to the pill's filled side so only half of it falls inside
    // the cell. For halfCircleLeft (diameter on right), anchor the
    // ellipse's right edge at x=cellWidth by positioning it at left=0
    // (making its center x=cellWidth). For halfCircleRight (diameter on
    // left), anchor the ellipse's left edge at x=0 by positioning it at
    // left=-cellWidth (making its center x=0).
    const ellipseLeft = shape === "halfCircleLeft" ? 0 : -cellWidth;
    return container({
      children: [
        container({
          children: [],
          style: {
            backgroundColor: fg,
            borderRadius: "50%",
            height: cellHeight,
            left: ellipseLeft,
            position: "absolute",
            top: 0,
            width: cellWidth * 2,
          } as any,
        }),
      ],
      style: {
        flexShrink: 0,
        height: cellHeight,
        overflow: "hidden",
        position: "relative",
        width: cellWidth,
        ...(bg ? { backgroundColor: bg } : {}),
      } as any,
    });
  }

  // Triangles render as 1px horizontal strips. Straight diagonal edges
  // need far less AA help than curves do; stair-stepping here is usually
  // imperceptible at typical terminal font sizes.
  const children: ReturnType<typeof container>[] = [];
  const cy = cellHeight / 2;
  for (let y = 0; y < cellHeight; y++) {
    const yc = y + 0.5;
    const dist = yc <= cy ? yc : cellHeight - yc;
    const fillWidth = Math.round((2 * cellWidth * dist) / cellHeight);
    if (fillWidth <= 0) continue;
    const fillLeft = shape === "triangleLeft" ? cellWidth - fillWidth : 0;
    children.push(
      container({
        children: [],
        style: {
          backgroundColor: fg,
          height: 1,
          left: fillLeft,
          position: "absolute",
          top: y,
          width: fillWidth,
        } as any,
      }),
    );
  }

  return container({
    children,
    style: {
      flexShrink: 0,
      height: cellHeight,
      overflow: "hidden",
      position: "relative",
      width: cellWidth,
      ...(bg ? { backgroundColor: bg } : {}),
    } as any,
  });
}

function renderMixedSpan(
  span: TerminalSpan,
  helpers: typeof import("@takumi-rs/helpers"),
  theme: ImageTheme,
  totalWidthPx: number,
  lineHeightPx: number,
  charWidth: number,
  globalColStart: number,
) {
  const { container } = helpers;
  const subRuns = splitIntoSubRuns(span.text);

  let totalGeoCols = 0;
  let totalTextChars = 0;
  for (const run of subRuns) {
    if (run.isGeo) totalGeoCols += run.charCount;
    else totalTextChars += run.charCount;
  }
  const remainingCols = span.width - totalGeoCols;

  let textCharsProcessed = 0;
  let textColsAssigned = 0;
  const runCols: number[] = [];
  for (const run of subRuns) {
    if (run.isGeo) {
      runCols.push(run.charCount);
    } else {
      textCharsProcessed += run.charCount;
      const target = totalTextChars > 0 ? Math.round((textCharsProcessed * remainingCols) / totalTextChars) : 0;
      runCols.push(target - textColsAssigned);
      textColsAssigned = target;
    }
  }

  const spanStartPx = Math.round(globalColStart * charWidth);
  let runColOffset = globalColStart;
  const children = subRuns.map((run, i) => {
    const cols = runCols[i]!;
    const startPx = Math.round(runColOffset * charWidth) - spanStartPx;
    const endPx = Math.round((runColOffset + cols) * charWidth) - spanStartPx;
    const widthPx = endPx - startPx;
    const subRunColStart = runColOffset;
    runColOffset += cols;

    const virtualSpan = { bg: span.bg, fg: span.fg, flags: span.flags, text: run.text, width: cols } as TerminalSpan;
    if (run.isGeo) {
      return geometricSpanNode(virtualSpan, helpers, theme, widthPx, lineHeightPx, charWidth, subRunColStart);
    }
    return spanToNode(virtualSpan, helpers, theme, widthPx);
  });

  return container({
    children,
    style: {
      display: "flex",
      flexDirection: "row",
      flexShrink: 0,
      height: "100%",
      overflow: "hidden",
      width: totalWidthPx,
    } as any,
  });
}

async function resolveExtraFallbackFonts(): Promise<ExtraFont[]> {
  if (cachedExtraFontsPromise) return cachedExtraFontsPromise;

  cachedExtraFontsPromise = (async () => {
    const fonts: ExtraFont[] = [];
    const seenPaths = new Set<string>([getBundledFallbackFontPath(), getBundledFontPath()]);

    for (const query of EXTRA_FALLBACK_QUERIES) {
      try {
        const output = await runCommand(["fc-match", "-f", "%{file}\n", query]);
        const path = output.trim();
        if (!path || seenPaths.has(path) || !existsSync(path)) continue;
        seenPaths.add(path);
        fonts.push({
          familyName: `HoneyshotsExtraFallback${fonts.length + 1}`,
          path,
        });
      } catch {
        // Best-effort only; fc-match is Linux-centric and may be absent.
      }
    }

    return fonts;
  })();

  return cachedExtraFontsPromise;
}

async function runCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, {
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${args.join(" ")}\n${stderr || stdout || "(no output)"}`);
  }
  return stdout;
}

function spanToNode(
  span: TerminalSpan,
  helpers: typeof import("@takumi-rs/helpers"),
  theme: ImageTheme,
  widthPx: number,
) {
  const { container, text } = helpers;

  const textStyle: Record<string, number | string> = {
    display: "inline",
    flexShrink: 0,
  };

  let fg = span.fg;
  let bg = span.bg;

  if (span.flags & StyleFlags.INVERSE) {
    const tmpFg = fg;
    fg = bg ?? theme.text;
    bg = tmpFg ?? theme.background;
  }

  if (fg) textStyle["color"] = fg;
  if (span.flags & StyleFlags.BOLD) textStyle["fontWeight"] = "bold";
  if (span.flags & StyleFlags.ITALIC) textStyle["fontStyle"] = "italic";
  if (span.flags & StyleFlags.FAINT) textStyle["opacity"] = 0.5;
  if (span.flags & StyleFlags.UNDERLINE) textStyle["textDecoration"] = "underline";
  if (span.flags & StyleFlags.STRIKETHROUGH)
    textStyle["textDecoration"] = textStyle["textDecoration"]
      ? `${textStyle["textDecoration"]} line-through`
      : "line-through";

  const containerStyle: Record<string, number | string> = {
    // Vertically center the text within the cell. Without this, glyphs
    // render at the font's baseline, which for many fonts — and
    // especially for nerd-font icon glyphs whose PUA boxes don't track
    // ASCII metrics — leaves the glyph visually off-center inside the
    // line box.
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    height: "100%",
    overflow: "hidden",
    width: widthPx,
  };
  if (bg) {
    containerStyle["backgroundColor"] = bg;
  }

  return container({
    children: [text(span.text, textStyle)],
    style: containerStyle,
  });
}

function splitIntoSubRuns(text: string): SubRun[] {
  const chars = [...text];
  if (chars.length === 0) return [];
  const runs: SubRun[] = [];
  let cur: SubRun | null = null;
  for (const ch of chars) {
    const geo = isGeometricChar(ch.codePointAt(0)!);
    if (cur && cur.isGeo === geo) {
      cur.text += ch;
      cur.charCount++;
    } else {
      cur = { charCount: 1, isGeo: geo, text: ch };
      runs.push(cur);
    }
  }
  return runs;
}

function trimTrailingEmptyLines(lines: TerminalLine[]): TerminalLine[] {
  let end = lines.length;
  while (end > 0 && isLineEmpty(lines[end - 1]!)) {
    end--;
  }
  return lines.slice(0, end);
}

export type { ImageTheme, RenderImageOptions } from "ghostty-opentui/image";
