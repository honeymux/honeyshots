#!/usr/bin/env bun
import { join } from "node:path";

/**
 * Smoke test: spawn a trivial OpenTUI React app that tags a region and
 * verify honeyshots markers reach the harness with correct geometry.
 *
 * Runs a child `bun run ./examples/smoke-opentui-app.tsx` under the harness
 * and reads the first marker frame.
 */
import { TuiHarness } from "../src/index.ts";

const appPath = join(import.meta.dirname, "smoke-opentui-app.tsx");

async function main(): Promise<number> {
  const harness = new TuiHarness({
    argv: [process.execPath, "run", appPath],
    cols: 80,
    rows: 24,
  });
  try {
    await harness.start();
    const region = await harness.waitForRegion("demo", 8_000);
    console.log("Received region:", region);
    if (region.w <= 0 || region.h <= 0) {
      console.error("Region has non-positive dimensions");
      return 1;
    }
    console.log("All regions:", harness.listRegions());
    return 0;
  } finally {
    await harness.close();
  }
}

process.exit(await main());
