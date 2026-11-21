// The `elmera-workspace` oxlint plugin: this workspace's contracts as lint rules, each failing with the fix. Oxlint
// loads it from source (`.oxlintrc.json`), so every module in its graph uses `.ts` specifiers and erasable syntax.
import type { Plugin } from "@oxlint/plugins";

import { exportPrefixes } from "./rules/export-prefixes.ts";
import { globalNames } from "./rules/global-names.ts";
import { importBoundaries } from "./rules/import-boundaries.ts";
import { instanceNames } from "./rules/instance-names.ts";
import { publicSurface } from "./rules/public-surface.ts";
import { sideEffectFree } from "./rules/side-effect-free.ts";
import { vocabulary } from "./rules/vocabulary.ts";

/** The workspace plugin; `.oxlintrc.json` loads it as `elmera-workspace`. */
const plugin: Plugin = {
  meta: { name: "elmera-workspace" },
  rules: {
    "export-prefixes": exportPrefixes,
    "global-names": globalNames,
    "import-boundaries": importBoundaries,
    "instance-names": instanceNames,
    "public-surface": publicSurface,
    "side-effect-free": sideEffectFree,
    vocabulary,
  },
};

export default plugin;
