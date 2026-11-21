import { importBoundaries } from "../src/rules/import-boundaries.ts";
import { createTester, fixture } from "./rule-tester.ts";

// Unit under test: elmera-workspace/import-boundaries. Oracle: the dependency direction intl-e2e → intl-tools → intl
// and the fixture manifests (runtime: intl-messageformat, peers react and effect, dev @types/react; tools:
// @elmeragroup/intl, oxc-parser, dev @oxlint/plugins), per case.
createTester().run("import-boundaries", importBoundaries, {
  valid: [
    {
      code: `import { useMemo } from "react";\nimport { IntlMessageFormat } from "intl-messageformat";\nimport { x } from "./intl";`,
      filename: fixture("runtime/src/react.tsx"),
    },
    {
      code: `import type { ReactNode } from "@types/react";\nexport type { Plugin } from "./plugin";`,
      filename: fixture("runtime/src/types.ts"),
    },
    // The runtime reaches its own subpaths by name.
    {
      code: `import { IntlMessageFormat } from "@elmeragroup/intl/internal/formatter";`,
      filename: fixture("runtime/src/icu.ts"),
    },
    {
      code: `import { keyOf } from "@elmeragroup/intl/internal/message";\nimport { parseSync } from "oxc-parser";\nimport type { Rule } from "@oxlint/plugins";\nimport { readFileSync } from "node:fs";`,
      filename: fixture("tools/src/extract.ts"),
    },
    // The /effect entry imports the optional peer, by its root and its modules; the runtime's tests may too.
    {
      code: `import * as Effect from "effect/Effect";\nimport { Layer } from "effect";\nimport { createIntl } from "./intl";`,
      filename: fixture("runtime/src/effect.ts"),
    },
    {
      code: `import * as ManagedRuntime from "effect/ManagedRuntime";`,
      filename: fixture("runtime/test/effect.test.ts"),
    },
    // Tests may use what their package's test config provides.
    {
      code: `import { compileCatalog } from "#compile";\nimport { describe } from "vitest";\nimport { join } from "node:path";`,
      filename: fixture("runtime/test/runtime.test.ts"),
    },
    {
      code: `import { T } from "@elmeragroup/intl/react";\nimport { withIntl } from "@elmeragroup/intl-tools/next";`,
      filename: fixture("app/src/page.tsx"),
    },
  ],
  invalid: [
    {
      code: `import { T } from "@elmeragroup/intl-e2e/fixtures";`,
      filename: fixture("app/src/page.tsx"),
      errors: [{ messageId: "e2e" }],
    },
    {
      code: `import { compileCatalog } from "@elmeragroup/intl-tools/compile";`,
      filename: fixture("runtime/test/a.test.ts"),
      errors: [{ messageId: "tools" }],
    },
    {
      code: `import { keyOf } from "@elmeragroup/intl/internal/message";`,
      filename: fixture("app/src/page.tsx"),
      errors: [{ messageId: "internal", data: { specifier: "@elmeragroup/intl/internal/message" } }],
    },
    {
      code: `import { readFileSync } from "node:fs";`,
      filename: fixture("runtime/src/catalog.ts"),
      errors: [{ messageId: "builtin", data: { specifier: "node:fs" } }],
    },
    {
      code: `import process from "process";`,
      filename: fixture("runtime/src/env.ts"),
      errors: [{ messageId: "builtin" }],
    },
    {
      code: `import { compileCatalog } from "../../tools/src/compile";`,
      filename: fixture("runtime/src/a.ts"),
      errors: [{ messageId: "outside" }],
    },
    {
      code: `import { corpus } from "#corpus";`,
      filename: fixture("tools/src/a.ts"),
      errors: [{ messageId: "outside" }],
    },
    // Any other runtime module would make the optional peer required: by a module path, the root, or types alone.
    {
      code: `import * as Effect from "effect/Effect";`,
      filename: fixture("runtime/src/server.ts"),
      errors: [{ messageId: "effect", data: { specifier: "effect/Effect" } }],
    },
    {
      code: `import type { Effect } from "effect";`,
      filename: fixture("runtime/src/effect/helpers.ts"),
      errors: [{ messageId: "effect", data: { specifier: "effect" } }],
    },
    {
      code: `import { createRoot } from "react-dom/client";`,
      filename: fixture("runtime/src/a.tsx"),
      errors: [
        { messageId: "undeclared", data: { specifier: "react-dom/client", package: "@elmeragroup/intl" } },
      ],
    },
    // A devDependency serves types only: a value import would be missing from a consumer's install.
    {
      code: `import { definePlugin } from "@oxlint/plugins";`,
      filename: fixture("tools/src/oxlint.ts"),
      errors: [{ messageId: "undeclared" }],
    },
    {
      code: `export async function f() { return import("vite"); }`,
      filename: fixture("tools/src/vite.ts"),
      errors: [{ messageId: "undeclared" }],
    },
  ],
});
