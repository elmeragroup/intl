"use client";
import { T } from "@elmeragroup/intl/react";

// Our runtime alone on a route, so its client chunks hold only our formatter.
export function IntlOnly() {
  return (
    <p id="intl-only">
      <T>Hello from an element</T>
    </p>
  );
}
