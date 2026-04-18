#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";

import { installAdapter } from "../src/opentui/index.ts";

function App() {
  return React.createElement(
    "box",
    {
      flexDirection: "column",
      height: 10,
      id: "honeyshots:demo",
      left: 4,
      position: "absolute",
      top: 2,
      width: 40,
    },
    React.createElement("text", { content: "hello from honeyshots smoke test" }),
  );
}

const renderer = await createCliRenderer({});
installAdapter(renderer);
createRoot(renderer).render(React.createElement(App));

setTimeout(() => process.exit(0), 1200);
