import type { TerminalData, TerminalLine, TerminalSpan } from "ghostty-opentui";

export interface TerminalCropRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

/**
 * Crop a TerminalData snapshot to the given rectangle in terminal-cell space.
 * Returns a new TerminalData with cols=width and rows=height.
 */
export function cropTerminalData(full: TerminalData, rect: TerminalCropRect): TerminalData {
  const { height, left, top, width } = rect;
  const croppedLines: TerminalLine[] = [];
  for (let row = top; row < top + height && row < full.lines.length; row++) {
    const line = full.lines[row]!;
    const croppedSpans: TerminalSpan[] = [];
    let col = 0;
    for (const span of line.spans) {
      const spanEnd = col + span.width;
      if (spanEnd <= left) {
        col = spanEnd;
        continue;
      }
      if (col >= left + width) break;
      const clipStart = Math.max(0, left - col);
      const clipEnd = Math.min(span.width, left + width - col);
      if (clipEnd > clipStart) {
        const textLen = span.text.length;
        const charStart = Math.round((clipStart * textLen) / span.width);
        const charEnd = Math.round((clipEnd * textLen) / span.width);
        croppedSpans.push({
          bg: span.bg,
          fg: span.fg,
          flags: span.flags,
          text: span.text.slice(charStart, charEnd),
          width: clipEnd - clipStart,
        });
      }
      col = spanEnd;
    }
    croppedLines.push({ spans: croppedSpans });
  }
  return {
    cols: width,
    cursor: [0, 0],
    cursorStyle: full.cursorStyle,
    cursorVisible: false,
    lines: croppedLines,
    offset: 0,
    rows: height,
    totalLines: croppedLines.length,
  };
}
