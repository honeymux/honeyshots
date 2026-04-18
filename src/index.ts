export { renderTerminalToImage } from "./core/render-terminal-to-image.ts";
export type { ImageTheme, RenderImageOptions } from "./core/render-terminal-to-image.ts";
export { cropTerminalData } from "./core/terminal-data-crop.ts";
export type { TerminalCropRect } from "./core/terminal-data-crop.ts";
export { TuiHarness } from "./harness/harness.ts";
export type { ShootOptions, TuiHarnessOptions } from "./harness/harness.ts";
export { ProbeResponder } from "./harness/probe-responder.ts";
export { MARKER_OSC_CODE, MarkerStreamParser, encodeMarker } from "./opentui/marker-protocol.ts";
export type { MarkerFrame, MarkerRegion } from "./opentui/marker-protocol.ts";
