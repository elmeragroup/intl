import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { VITE_EVENTS } from "../src/rules/global-names.ts";

// Unit under test: global-names' list of Vite's own HMR events. Oracle: the installed Vite's declarations, the keys of
// `CustomEventMap` in `vite/types/customEvent.d.ts`, so a Vite bump that adds or renames an event fails here.
it("exempts exactly the events Vite declares", () => {
  // The `types/*` export carries only a types condition, so resolve the package and read the file beside its manifest.
  const vite = dirname(createRequire(import.meta.url).resolve("vite/package.json"));
  const declarations = readFileSync(join(vite, "types", "customEvent.d.ts"), "utf8");
  const map = /interface CustomEventMap \{(?<body>[\s\S]*?)\n\}/u.exec(declarations)?.groups?.body ?? "";
  const declared = [...map.matchAll(/^\s*'(?<name>vite:[^']+)'/gmu)].map((match) => match.groups?.name ?? "");

  expect(declared.length).toBeGreaterThan(0);
  expect([...VITE_EVENTS].toSorted()).toEqual(declared.toSorted());
});
