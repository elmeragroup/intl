import type * as Compile from "#compile";
// Benchmark, not a test: per-request translation cost over a compiled catalog and the client formatter's size, the
// numbers a PR's G9 gate reports. Run `pnpm bench` from the repository root, which builds both packages first; it
// reads the built runtime through its exports and the built compiler by path (intl-tools depends on this package,
// not the reverse).
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";

import type { MessageValue } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

const MESSAGES = 200;
const WARM_UP = 20;
const REQUESTS = 200;
const ZONE = "Europe/Oslo";
const DUE = new Date("2026-01-01T23:30:00Z");

// Four shapes, 50 each: plain text, a number, a styled date and a plural, each with an nb translation.
type Entry = {
  readonly source: string;
  readonly nb: string;
  readonly values: Readonly<Record<string, MessageValue>>;
};

const corpus = Array.from({ length: MESSAGES }, (_, i): Entry => {
  switch (i % 4) {
    case 0:
      return {
        source: `Hello {name}, message ${i}`,
        nb: `Hei {name}, melding ${i}`,
        values: { name: "Ada" },
      };
    case 1:
      return {
        source: `You have {n, number} orders (${i})`,
        nb: `Du har {n, number} ordrer (${i})`,
        values: { n: 1234 },
      };
    case 2:
      return {
        source: `Due {d, date, short} (${i})`,
        nb: `Forfall {d, date, short} (${i})`,
        values: { d: DUE },
      };
    default:
      return {
        source: `{n, plural, one {# item} other {# items}} (${i})`,
        nb: `{n, plural, one {# vare} other {# varer}} (${i})`,
        values: { n: 2 },
      };
  }
});
const po = [
  'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=utf-8\\n"\n',
  ...corpus.map(({ source, nb }) => `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(nb)}\n`),
].join("\n");
// The built compiler by path at runtime, typed from its source (`#compile`), so type-checking this package needs no
// intl-tools build.
const compilerUrl = new URL("../../intl-tools/dist/compile.js", import.meta.url).href;
// SAFETY: the module at that path is the build of the source `#compile` names; a stale or missing build fails here.
const { compileCatalog } = (await import(compilerUrl)) as typeof Compile;
const result = compileCatalog(po, "nb");

if (result._tag !== "Compiled") {
  throw result;
}

const { catalog } = result;

// One request: a fresh translator, as the server builds per request, rendering every message once. The catalog object
// is the process's, as an app's imported catalog module is, so its decoded entries are shared after the first request.
function request(): number {
  const start = performance.now();
  const { t } = createIntl({ locale: "nb", catalog, timeZone: ZONE });
  for (const { source, values } of corpus) {
    // SAFETY: only msg() brands a descriptor, and it takes literals; the corpus is generated, and the runtime reads
    // only message and context, which this object has.
    t.from({ message: source, context: undefined } as Parameters<typeof t.from>[0], values);
  }

  return performance.now() - start;
}

function median(samples: ReadonlyArray<number>): number {
  const sorted = samples.toSorted((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function gzipBytes(entry: string): Promise<number> {
  const bundle = await rolldown({ input: entry, platform: "browser", logLevel: "silent" });
  const { output } = await bundle.generate({ format: "esm", minify: true });
  await bundle.close();

  return output.reduce((sum, file) => sum + (file.type === "chunk" ? gzipSync(file.code).length : 0), 0);
}

const cold = request();
for (let i = 0; i < WARM_UP; i += 1) {
  request();
}

const warm = median(Array.from({ length: REQUESTS }, request));
const formatter = fileURLToPath(new URL("../dist/internal/formatter.js", import.meta.url));
const sizes = [
  ["intl-messageformat (with parser), min+gzip", await gzipBytes("intl-messageformat")],
  ...(existsSync(formatter)
    ? [["/internal/formatter (no parser), min+gzip", await gzipBytes(formatter)] as const]
    : []),
] as const;

console.table([
  { metric: `cold request, ${MESSAGES} messages (ms)`, value: cold.toFixed(2) },
  { metric: `warm request, ${MESSAGES} messages, median of ${REQUESTS} (ms)`, value: warm.toFixed(3) },
  { metric: "warm per message (µs)", value: ((warm * 1000) / MESSAGES).toFixed(2) },
  ...sizes.map(([metric, bytes]) => ({ metric, value: `${bytes} B` })),
]);
