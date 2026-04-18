import type { Renderable } from "@opentui/core";

import React, { type ReactNode, type Ref, useCallback, useEffect, useRef } from "react";

export const REGION_ID_PREFIX = "honeyshots:";
const HONEYSHOTS_TAG = Symbol.for("honeyshots.region");

export interface RegionProps {
  children: ReactNode;
  /** Stable name used to look up this region from the harness. */
  name: string;
  /**
   * Optional disambiguator for multiple regions sharing a name (e.g. two
   * "pane" regions in a split view). Expose via `nth` on {@link MarkerRegion}.
   */
  nth?: number;
}

/**
 * Tags the child subtree so the honeyshots harness can resolve its current
 * screen-cell rect by name. Renders as a passthrough: if the adapter is
 * active, attaches a ref to the single child; otherwise, no-ops.
 *
 * The child must be a single React element that accepts a ref (any OpenTUI
 * renderable element such as `<box>`, `<text>`, etc.). If you need to tag
 * multiple siblings with one region, wrap them in a container first.
 */
export function Region({ children, name, nth }: RegionProps): React.ReactElement {
  const internalRef = useRef<Renderable | null>(null);

  const attach = useCallback(
    (node: Renderable | null) => {
      internalRef.current = node;
      if (node) {
        tagRenderable(node, name, nth);
      }
    },
    [name, nth],
  );

  useEffect(() => {
    if (internalRef.current) {
      tagRenderable(internalRef.current, name, nth);
    }
  }, [name, nth]);

  if (!React.isValidElement(children)) {
    throw new Error(
      "honeyshots <Region> requires exactly one React element child that accepts a ref (e.g. <box>). " +
        "Wrap multiple children in a single container element.",
    );
  }

  const childRef = (children as { ref?: Ref<Renderable> } & React.ReactElement).ref;
  return React.cloneElement(children as React.ReactElement<{ ref?: Ref<Renderable> }>, {
    ref: mergeRefs<Renderable>(childRef, attach),
  });
}

export function readRegionTag(renderable: Renderable): { name: string; nth?: number } | null {
  const value = (renderable as unknown as Record<symbol, { name: string; nth?: number } | undefined>)[HONEYSHOTS_TAG];
  return value ?? null;
}

/**
 * Internal tag on Renderable instances that the adapter discovers during
 * tree traversal. Using a symbol keeps the field off plain property lookup
 * and avoids collisions with any user-defined id/testid scheme.
 */
export function tagRenderable(renderable: Renderable, name: string, nth?: number): void {
  (renderable as unknown as Record<symbol, { name: string; nth?: number }>)[HONEYSHOTS_TAG] = {
    name,
    ...(nth === undefined ? {} : { nth }),
  };
}

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): Ref<T> {
  return (value: T) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(value);
      } else {
        (ref as { current: T }).current = value;
      }
    }
  };
}

Region.displayName = "HoneyshotsRegion";
