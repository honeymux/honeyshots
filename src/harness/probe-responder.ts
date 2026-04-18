/**
 * Replies to Cursor Position Report (CPR) probes emitted by many TUIs at
 * startup so the app thinks it is attached to a real cooperative terminal.
 *
 * Honeymux's startup probe asks for CPR twice: the first reply establishes
 * "yes, someone is listening," the second confirms the reported cursor
 * position. We send distinct canned replies so the caller can distinguish.
 */
export class ProbeResponder {
  private buffer = "";
  private cprReplies = 0;

  constructor(private readonly write: (data: string) => void) {}

  onOutput(data: Buffer): void {
    if (this.cprReplies >= 2) return;
    this.buffer += data.toString("latin1");
    while (this.cprReplies < 2) {
      const idx = this.buffer.indexOf("\x1b[6n");
      if (idx === -1) {
        this.buffer = this.buffer.slice(-32);
        return;
      }
      this.buffer = this.buffer.slice(idx + 4);
      this.cprReplies += 1;
      this.write(this.cprReplies === 1 ? "\x1b[1;1R" : "\x1b[1;2R");
    }
  }
}
