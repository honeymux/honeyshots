/**
 * honeyshots uses a custom OSC sequence (OSC 5700) to transport region
 * coordinates from the running app out to the harness. The sequence is
 * stripped from the PTY stream before it reaches the terminal buffer, so it
 * never appears on screen.
 *
 * Frame format:
 *
 *   ESC ] 5700 ; <json> BEL
 *
 * Where <json> is a {@link MarkerFrame} payload. OSC 5700 is unassigned in
 * common terminal emulators and chosen to avoid collisions.
 */

export interface MarkerFrame {
  /** All regions alive at the time the frame was emitted. */
  regions: MarkerRegion[];
  /** Monotonically increasing frame counter. */
  seq: number;
  /** Wall-clock ms at emit time; aids diagnostics only. */
  t?: number;
}

export interface MarkerRegion {
  /** Height in cells. */
  h: number;
  /** Region name as declared by the app (e.g. "sidebar"). */
  name: string;
  /** Optional numeric id used to disambiguate duplicate names. */
  nth?: number;
  /** Width in cells. */
  w: number;
  /** Absolute column of the top-left cell. */
  x: number;
  /** Absolute row of the top-left cell. */
  y: number;
}

export const MARKER_OSC_CODE = 5700;
const MARKER_PREFIX = `\x1b]${MARKER_OSC_CODE};`;
const MARKER_ST_BEL = "\x07";
const MARKER_ST_ESC = "\x1b\\";

export interface ParseResult {
  /** Bytes with marker sequences removed, safe to forward to the terminal. */
  cleaned: Buffer;
  /** Frames successfully parsed from this chunk. */
  frames: MarkerFrame[];
  /** Bytes held back because they may contain an unterminated marker. */
  pending: Buffer;
}

/**
 * Stream-aware marker parser. Feed incoming bytes one chunk at a time; it
 * handles sequences split across chunk boundaries without unbounded buffering.
 *
 * The parser is bounded: any unterminated marker longer than {@link MAX_MARKER_BYTES}
 * is discarded as unrecoverable.
 */
export class MarkerStreamParser {
  static readonly MAX_MARKER_BYTES = 64 * 1024;

  private carry: Buffer = Buffer.alloc(0);

  /**
   * Flush any remaining buffered bytes. Call when the source stream closes to
   * recover trailing content that never had a terminator.
   */
  flush(): Buffer {
    const remaining = this.carry;
    this.carry = Buffer.alloc(0);
    return remaining;
  }

  /**
   * Consume a chunk. Returns the cleaned (marker-free) bytes that should be
   * forwarded to the terminal buffer, plus any parsed frames.
   */
  push(chunk: Buffer): { cleaned: Buffer; frames: MarkerFrame[] } {
    const combined = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const { cleaned, frames, pending } = this.parse(combined);
    this.carry = pending;
    return { cleaned, frames };
  }

  private parse(input: Buffer): ParseResult {
    const cleanedParts: Buffer[] = [];
    const frames: MarkerFrame[] = [];
    let cursor = 0;

    while (cursor < input.length) {
      const startIdx = input.indexOf(MARKER_PREFIX, cursor, "latin1");
      if (startIdx === -1) {
        cleanedParts.push(input.subarray(cursor));
        break;
      }

      if (startIdx > cursor) {
        cleanedParts.push(input.subarray(cursor, startIdx));
      }

      const payloadStart = startIdx + MARKER_PREFIX.length;

      const belIdx = input.indexOf(MARKER_ST_BEL, payloadStart, "latin1");
      const stIdx = input.indexOf(MARKER_ST_ESC, payloadStart, "latin1");

      let terminatorIdx = -1;
      let terminatorLen = 0;
      if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
        terminatorIdx = belIdx;
        terminatorLen = 1;
      } else if (stIdx !== -1) {
        terminatorIdx = stIdx;
        terminatorLen = 2;
      }

      if (terminatorIdx === -1) {
        if (input.length - startIdx > MarkerStreamParser.MAX_MARKER_BYTES) {
          break;
        }
        return {
          cleaned: Buffer.concat(cleanedParts),
          frames,
          pending: input.subarray(startIdx),
        };
      }

      const payload = input.subarray(payloadStart, terminatorIdx).toString("latin1");
      try {
        frames.push(JSON.parse(payload) as MarkerFrame);
      } catch {
        // Malformed marker; drop it quietly and resume after the terminator.
      }
      cursor = terminatorIdx + terminatorLen;
    }

    return {
      cleaned: Buffer.concat(cleanedParts),
      frames,
      pending: Buffer.alloc(0),
    };
  }
}

/**
 * Encode a marker frame as a complete OSC sequence. Uses BEL as the string
 * terminator because it is the most widely-supported variant.
 */
export function encodeMarker(frame: MarkerFrame): string {
  return MARKER_PREFIX + JSON.stringify(frame) + MARKER_ST_BEL;
}
