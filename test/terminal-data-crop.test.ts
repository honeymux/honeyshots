import type { TerminalData } from "ghostty-opentui";

import { describe, expect, test } from "bun:test";

import { cropTerminalData } from "../src/core/terminal-data-crop.ts";

function frame(rows: string[][]): TerminalData {
  const cols = rows[0]?.reduce((n, s) => n + s.length, 0) ?? 0;
  return {
    cols,
    cursor: [0, 0],
    cursorStyle: "default",
    cursorVisible: false,
    lines: rows.map((r) => ({ spans: r.map((s) => span(s)) })),
    offset: 0,
    rows: rows.length,
    totalLines: rows.length,
  };
}

function span(text: string, width = text.length, fg: null | string = null, bg: null | string = null) {
  return { bg, fg, flags: 0, text, width };
}

describe("cropTerminalData", () => {
  test("returns a new frame with rect dimensions", () => {
    const full = frame([["hello world"], ["second line"]]);
    const cropped = cropTerminalData(full, { height: 1, left: 2, top: 0, width: 5 });
    expect(cropped.cols).toBe(5);
    expect(cropped.rows).toBe(1);
    expect(cropped.lines).toHaveLength(1);
    expect(cropped.lines[0]!.spans[0]!.text).toBe("llo w");
  });

  test("crops rows and columns together", () => {
    const full = frame([["aaaa"], ["bbbb"], ["cccc"]]);
    const cropped = cropTerminalData(full, { height: 2, left: 1, top: 1, width: 2 });
    expect(cropped.rows).toBe(2);
    expect(cropped.lines[0]!.spans[0]!.text).toBe("bb");
    expect(cropped.lines[1]!.spans[0]!.text).toBe("cc");
  });
});
