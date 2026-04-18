import { describe, expect, test } from "bun:test";

import { type MarkerFrame, MarkerStreamParser, encodeMarker } from "../src/opentui/marker-protocol.ts";

const sampleFrame: MarkerFrame = {
  regions: [
    { h: 40, name: "sidebar", w: 32, x: 0, y: 3 },
    { h: 40, name: "toolbar", w: 7, x: 125, y: 3 },
  ],
  seq: 1,
};

describe("MarkerStreamParser", () => {
  test("extracts a single marker sandwiched between terminal output", () => {
    const parser = new MarkerStreamParser();
    const marker = encodeMarker(sampleFrame);
    const chunk = Buffer.from(`before${marker}after`, "latin1");

    const { cleaned, frames } = parser.push(chunk);

    expect(cleaned.toString("latin1")).toBe("beforeafter");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.regions).toEqual(sampleFrame.regions);
  });

  test("joins a marker split across two chunks", () => {
    const parser = new MarkerStreamParser();
    const marker = encodeMarker(sampleFrame);
    const splitAt = Math.floor(marker.length / 2);
    const first = Buffer.from(`hi${marker.slice(0, splitAt)}`, "latin1");
    const second = Buffer.from(`${marker.slice(splitAt)}bye`, "latin1");

    const firstPass = parser.push(first);
    expect(firstPass.frames).toHaveLength(0);
    expect(firstPass.cleaned.toString("latin1")).toBe("hi");

    const secondPass = parser.push(second);
    expect(secondPass.frames).toHaveLength(1);
    expect(secondPass.cleaned.toString("latin1")).toBe("bye");
  });

  test("tolerates multiple markers and an unterminated trailer", () => {
    const parser = new MarkerStreamParser();
    const first = encodeMarker({ regions: [{ h: 1, name: "a", w: 1, x: 0, y: 0 }], seq: 1 });
    const second = encodeMarker({ regions: [{ h: 2, name: "b", w: 2, x: 0, y: 0 }], seq: 2 });
    const truncated = '\x1b]5700;{"seq":3,';
    const chunk = Buffer.from(first + "mid" + second + "tail" + truncated, "latin1");

    const { cleaned, frames } = parser.push(chunk);

    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(cleaned.toString("latin1")).toBe("midtail");
  });

  test("supports ST terminator (ESC \\\\) in addition to BEL", () => {
    const parser = new MarkerStreamParser();
    const payload = JSON.stringify({ regions: [{ h: 4, name: "x", w: 3, x: 1, y: 2 }], seq: 7 });
    const marker = `\x1b]5700;${payload}\x1b\\`;
    const { frames } = parser.push(Buffer.from(marker, "latin1"));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.seq).toBe(7);
  });

  test("drops malformed payloads but keeps the stream consistent", () => {
    const parser = new MarkerStreamParser();
    const good = encodeMarker(sampleFrame);
    const bad = "\x1b]5700;not-json\x07";
    const chunk = Buffer.from(`${bad}${good}`, "latin1");

    const { cleaned, frames } = parser.push(chunk);

    expect(cleaned.toString("latin1")).toBe("");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.seq).toBe(sampleFrame.seq);
  });
});
