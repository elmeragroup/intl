// Benchmark, not a test: what the build-time tools cost their hosts, the numbers each PR's G9 gate reports against
// the last. Run `pnpm bench` from the repository root, which builds the packages first; it reads only the built package
// (`dist`, `bin`), by path, as a consumer's host loads it.
//
// - The CLI's cold start: a fresh `elmera-intl extract` and `check` process on a settled fixture project (both exit 0,
//   extract writes nothing), the cost a script or CI step pays.
// - Compiling one `*.po` import through the Turbopack/webpack loader and through the Vite plugin's `load` hook: the
//   first call (a fresh worker or dev server, which evaluates the formats module in a child Node) and the mean of the
//   calls after it. Each runs in its own process, so neither inherits the other's memo.
// - Each built entry's cold import, in a fresh process: the cost a host pays to load the plugin or loader at all.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Catalog } from "@elmeragroup/intl/core";
import { createIntl } from "@elmeragroup/intl/core";

import type * as PoLoader from "../src/po-loader";
import type * as Vite from "../src/vite";

const PROCESS_RUNS = 9;
const COMPILES = 50;
const SOURCE_FILES = 12;
const LOCALES = ["nb", "sv"] as const;

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PACKAGE, "bin/elmera-intl.js");
const distUrl = (file: string): string => new URL(`../dist/${file}`, import.meta.url).href;

// The host's own module caches stay out of the samples: every process loads every module cold.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "NODE_COMPILE_CACHE" && name !== "NODE_OPTIONS")
);

function median(samples: ReadonlyArray<number>): number {
  const sorted = samples.toSorted((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function millis(value: number): string {
  return value.toFixed(1);
}

function mean(samples: ReadonlyArray<number>): number {
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

// A project shaped like an app's: several components, each with plain, placeholder, plural and formatted messages,
// two locales and a formats module.
function writeFixture(root: string): void {
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    "elmera-intl.json",
    JSON.stringify({
      include: ["src/**/*.{ts,tsx}"],
      catalogs: "messages/{locale}.po",
      locales: LOCALES,
      formats: "src/intl-formats.ts",
    })
  );
  write(
    "src/intl-formats.ts",
    'export const formats = { number: { money: { style: "currency", currency: "NOK" } } };\n'
  );
  for (let i = 0; i < SOURCE_FILES; i += 1) {
    write(
      `src/feature-${i}/view.tsx`,
      `import { T, msg } from "@elmeragroup/intl/react";

export const TITLE = msg("Feature ${i} overview");
export const ORDER = msg("Order {id} for feature ${i}");
export const ITEMS = msg("{n, plural, one {# item in feature ${i}} other {# items in feature ${i}}}");
export const PRICE = msg("Feature ${i} costs {amount, number, money}");
export const View = () => <T>Welcome to feature ${i}</T>;
`
    );
  }
}

/** One spawned CLI process: how long it ran and its exit code. */
type CliRun = { readonly ms: number; readonly status: number | null };

function cli(root: string, args: ReadonlyArray<string>): CliRun {
  const start = performance.now();
  const run = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: childEnv, encoding: "utf8" });

  return { ms: performance.now() - start, status: run.status };
}

function expectStatus(label: string, status: number | null, expected: number): void {
  if (status !== expected) {
    throw new Error(
      `${label} exited ${String(status)}, not ${expected}: the fixture is broken, so the timing is not`
    );
  }
}

// Every msgstr filled with the locale's prefix before the source, which keeps each placeholder and plural arm.
function translate(root: string): void {
  for (const locale of LOCALES) {
    const path = join(root, `messages/${locale}.po`);
    const po = readFileSync(path, "utf8").replaceAll(/^msgid "(.+)"\nmsgstr ""$/gmu, (_, source: string) => {
      return `msgid "${source}"\nmsgstr "${locale} ${source}"`;
    });
    writeFileSync(path, po);
  }
}

function settle(root: string): void {
  expectStatus("extract (first)", cli(root, ["extract"]).status, 0);
  translate(root);
  expectStatus("extract (settle)", cli(root, ["extract"]).status, 0);
  expectStatus("check (settle)", cli(root, ["check"]).status, 0);
}

function cliColdStart(root: string, command: "extract" | "check"): number {
  return median(
    Array.from({ length: PROCESS_RUNS }, () => {
      const { ms, status } = cli(root, [command]);
      expectStatus(command, status, 0);

      return ms;
    })
  );
}

type CompileTimes = { readonly first: number; readonly mean: number };

// One host's compile timings, measured in this script run as a child process (`compile <host> <root>`).
function compileTimes(host: "loader" | "vite", root: string): CompileTimes {
  const run = spawnSync(process.execPath, [import.meta.filename, "compile", host, root], {
    env: childEnv,
    encoding: "utf8",
  });

  if (run.status !== 0) {
    throw new Error(`compile ${host} failed:\n${run.stderr}`);
  }

  const parsed: unknown = JSON.parse(run.stdout);

  // SAFETY: the child is this script's `compile` mode, which prints exactly this shape.
  return parsed as CompileTimes;
}

// A sample counts only when the compile produced that sample's catalog. Each sample compiles its own revision of the
// PO, with the probe message translated differently, so a host that memoised an earlier compile fails; the module it
// returned is imported outside the timed interval and must carry that revision's translation. A hook that skipped the
// compile, or returned a stub module, would otherwise record a near-zero time. The worker and its formats memo stay
// warm: only the PO text changes.
const PROBE = "Feature 0 overview";
const PROBE_MSGSTR = `msgstr "nb ${PROBE}"`;
const probeTranslation = (sample: number): string => `nb ${PROBE} (revision ${sample})`;

async function verifyCatalog(host: string, code: string | undefined, sample: number): Promise<void> {
  if (code === undefined) {
    throw new Error(`${host} returned no module: the timing would not be a compile`);
  }

  // SAFETY: a compiled catalog module's default export is the catalog; a stub fails the translation check below.
  const { default: catalog } = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
    readonly default: Catalog;
  };
  const translated = createIntl({ locale: "nb", catalog, timeZone: "UTC" }).t(PROBE);

  if (translated !== probeTranslation(sample)) {
    throw new Error(
      `${host} returned a module translating "${PROBE}" as "${translated}", not "${probeTranslation(sample)}": not this sample's compile`
    );
  }
}

// Times one compile per PO revision, written to the catalog's path (where the Vite hook reads it) and passed as text
// (as the loader receives it) before the clock starts; the original PO is restored afterwards.
async function timeCompiles(
  host: string,
  root: string,
  compile: (po: string) => Promise<string | undefined>
): Promise<CompileTimes> {
  const path = join(root, "messages/nb.po");
  const original = readFileSync(path, "utf8");

  if (!original.includes(PROBE_MSGSTR)) {
    throw new Error(`the fixture PO has no ${PROBE_MSGSTR}`);
  }

  const time = async (sample: number): Promise<number> => {
    const po = original.replace(PROBE_MSGSTR, `msgstr "${probeTranslation(sample)}"`);
    writeFileSync(path, po);
    const start = performance.now();
    const code = await compile(po);
    const elapsed = performance.now() - start;
    await verifyCatalog(host, code, sample);

    return elapsed;
  };
  // One at a time: overlapping compiles would time the event loop, not a compile.
  const timeRest = async (sample: number, samples: ReadonlyArray<number>): Promise<ReadonlyArray<number>> =>
    sample > COMPILES ? samples : timeRest(sample + 1, [...samples, await time(sample)]);
  try {
    const first = await time(0);

    return { first, mean: mean(await timeRest(1, [])) };
  } finally {
    writeFileSync(path, original);
  }
}

async function loaderCompile(root: string): Promise<CompileTimes> {
  // SAFETY: the module at that path is the build of src/po-loader.ts.
  const { default: poLoader } = (await import(distUrl("po-loader.js"))) as typeof PoLoader;

  return timeCompiles("the po-loader", root, async (po) => {
    const done = Promise.withResolvers<string | undefined>();
    poLoader.call(
      {
        resourcePath: join(root, "messages/nb.po"),
        getOptions: () => ({ config: join(root, "elmera-intl.json"), source: false }),
        addDependency: () => undefined,
        async: () => (error, code) => {
          if (error === null) {
            done.resolve(code);
          } else {
            done.reject(error);
          }
        },
      },
      po
    );

    return done.promise;
  });
}

async function viteCompile(root: string): Promise<CompileTimes> {
  // SAFETY: the module at that path is the build of src/vite.ts.
  const { intlCatalogs } = (await import(distUrl("vite.js"))) as typeof Vite;
  const plugin = intlCatalogs();
  // Either form Vite accepts: the hook itself, or an object holding it as `handler`.
  const { load: hook } = plugin;
  const load = hook !== undefined && "handler" in hook ? hook.handler : hook;

  if (load === undefined) {
    throw new TypeError("intlCatalogs() has no load hook");
  }

  // The part of Vite's plugin context the hook reads.
  const context = {
    environment: { config: { root } },
    addWatchFile: () => undefined,
    error: (message: string) => {
      throw new Error(message);
    },
  };

  // The hook reads the revision timeCompiles wrote to the catalog's path.
  return timeCompiles("the vite load hook", root, async () => {
    // SAFETY: Vite's full plugin context is not constructible here; the hook reads only the environment's root,
    // addWatchFile and error, which this context has, and a read of anything else fails the bench.
    const loaded = await load.call(context as never, join(root, "messages/nb.po"));
    return loaded instanceof Object ? loaded.code : (loaded ?? undefined);
  });
}

// A fresh Node per sample, which imports the entry and prints how long the import took.
function coldImport(url: string): number {
  return median(
    Array.from({ length: PROCESS_RUNS }, () => {
      const run = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const start = performance.now(); await import(${JSON.stringify(url)}); process.stdout.write(String(performance.now() - start));`,
        ],
        { cwd: PACKAGE, env: childEnv, encoding: "utf8" }
      );
      expectStatus(`import ${url}`, run.status, 0);

      return Number(run.stdout);
    })
  );
}

const ENTRIES = [
  ["./vite", "vite.js"],
  ["./next", "next.js"],
  ["./vitest", "vitest.js"],
  ["./oxlint", "oxlint.js"],
  ["./compile", "compile.js"],
  ["po-loader (Turbopack/webpack loader)", "po-loader.js"],
] as const;

function main(): void {
  const root = mkdtempSync(join(tmpdir(), "elmera-intl-bench-"));
  try {
    writeFixture(root);
    settle(root);
    const extract = cliColdStart(root, "extract");
    const check = cliColdStart(root, "check");
    const loader = compileTimes("loader", root);
    const vite = compileTimes("vite", root);
    const imports = ENTRIES.map(([entry, file]) => [entry, coldImport(distUrl(file))] as const);
    // The bin's whole startup with no command: imports, then the usage error (exit 2).
    const usage = median(
      Array.from({ length: PROCESS_RUNS }, () => {
        const { ms, status } = cli(root, []);
        expectStatus("elmera-intl (no command)", status, 2);

        return ms;
      })
    );

    console.table([
      { metric: `CLI cold start: extract, settled (median of ${PROCESS_RUNS}, ms)`, value: millis(extract) },
      { metric: `CLI cold start: check (median of ${PROCESS_RUNS}, ms)`, value: millis(check) },
      {
        metric: `CLI cold start: no command, usage exit (median of ${PROCESS_RUNS}, ms)`,
        value: millis(usage),
      },
      { metric: "po-loader compile: first call (ms)", value: millis(loader.first) },
      { metric: `po-loader compile: mean of next ${COMPILES} (ms)`, value: millis(loader.mean) },
      { metric: "vite load compile: first call (ms)", value: millis(vite.first) },
      { metric: `vite load compile: mean of next ${COMPILES} (ms)`, value: millis(vite.mean) },
      ...imports.map(([entry, value]) => ({
        metric: `cold import ${entry} (median of ${PROCESS_RUNS}, ms)`,
        value: millis(value),
      })),
      { metric: "cold import ./po", value: "n/a (types only)" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const [mode, host, root] = process.argv.slice(2);

if (mode === "compile" && root !== undefined) {
  const times = host === "vite" ? await viteCompile(root) : await loaderCompile(root);
  process.stdout.write(JSON.stringify(times));
} else {
  main();
}
