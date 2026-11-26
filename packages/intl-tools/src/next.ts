// Next.js hosting: `withIntl` adds the Turbopack rule that compiles `*.po` imports and the alias that hands the runtime
// the app's request config. Check and watch run as scripts
// (`elmera-intl check && next build`, `extract --watch` beside `next dev`), because Next loads its config in more than
// one process.
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { realPath } from "./project-catalogs";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE, loadConfig } from "./project-config";
import type { TurbopackRoot, TurbopackRoots } from "./turbopack-roots";
import { canonical, isBelow } from "./turbopack-roots";

/** Options for `withIntl`. */
export type WithIntlOptions = {
  /**
   * The Next project directory: `import.meta.dirname` in `next.config.ts`. Next is resolved and its root detected from
   * here, not from `process.cwd()`, which differs from it under `next build <dir>`.
   */
  readonly dir: string;
  /** Path of `elmera-intl.json`, relative to `dir`; defaults to its `elmera-intl.json`. */
  readonly config?: string;
  /**
   * Path of the app's request module, relative to `dir`; defaults to `./intl/request.ts`, aliased only when that file
   * exists. Its default export is `createRequestConfig(adapter)` from `@elmeragroup/intl/next/server`.
   */
  readonly request?: string;
};

/** What withIntl spreads must be a plain object: not a function, thenable or array, whose fields a spread drops. */
type PlainObject = { readonly apply?: never; readonly then?: never; readonly length?: never };

/**
 * The part of a Next config `withIntl` reads and extends, typed here so this package needs no `next` (a non-Next
 * host app's pruned install would then carry Next). The rule and alias maps stay opaque: Next owns their entries, and
 * `withIntl` only adds its own beside them.
 */
export type IntlNextConfig = {
  /** Next's root for file tracing, which it also makes Turbopack's root. */
  readonly outputFileTracingRoot?: string;
  readonly turbopack?: object &
    PlainObject & {
      /** The directory Turbopack resolves files in and matches rule paths against. */
      readonly root?: string;
      readonly rules?: object;
      /** Module aliases, by specifier; withIntl adds the request module's. */
      readonly resolveAlias?: object;
    };
};

/** What the loader receives as options: JSON only. */
export type PoLoaderOptions = {
  /** Absolute path of `elmera-intl.json`. */
  readonly config: string;
  /** Compile the msgids as the English catalog (`?source`). */
  readonly source: boolean;
  /**
   * Turbopack's roots, outside which the loader registers no dependency and fails the import with the fix; absent when
   * Next selects an adapter, which may add roots after next.config is evaluated.
   */
  readonly roots?: TurbopackRoots;
};

const PO_GLOB = "*.po";
// The runtime's request module: `getIntl` reads it through `internal/request-config`, whose react-server condition alone
// imports this specifier, so the alias reaches the app's module only from server components, actions and route
// handlers. Client and SSR code resolve the request config to the runtime's stub.
const REQUEST_MODULE = "@elmeragroup/intl/internal/request-module";
const DEFAULT_REQUEST = "./intl/request.ts";

/**
 * Add `@elmeragroup/intl` to a Next config, in every layer, dev and build:
 *
 * - A Turbopack rule: `import catalog from "./intl/no.po"` compiles the `no` catalog and `"./intl/no.po?source"` the
 *   English one. The rule matches only the configured catalogs' paths below Turbopack's root (as Next determines it), so
 *   another library's `*.po` rule (next-intl's) keeps its files; an existing `*.po` key becomes an array with this rule
 *   appended.
 * - A Turbopack alias from the runtime's request module to the app's, so `getIntl`, `getT`, `getFormat` and the server
 *   `<T>`/`useT` read the request without any page, layout, action or route importing setup code. Only the runtime's
 *   react-server request config imports that specifier, so a Client Component that imports `/server` by mistake gets
 *   the runtime's stub, never the app's adapter, in its chunks.
 *
 * withIntl returns Next's phase function, so it goes outermost: Next calls it with the phase it loads the config in.
 * Where Next compiles (`next build`, `next typegen`, `next dev`, a dev custom server, `next analyze`), it reads the
 * project and adds the rule and the alias. Every other phase (`next start`, a production custom server) compiles
 * nothing: there withIntl reads nothing and returns the config as passed, so a pruned deployment needs no
 * `elmera-intl.json` and no source.
 *
 * @template C - The app's config type.
 * @param config - The Next config.
 * @param options - The project directory, where `elmera-intl.json` lives, and the request module.
 * @returns Next's phase function, returning the config with the rule and the alias in a phase that compiles and the
 *   config itself in any other, typed as the config passed: the Turbopack rule and alias entries withIntl writes are
 *   Next's to read, not part of this API.
 * @throws When the config or its `turbopack` is not a plain object (a phase function, a thenable, an array, a class
 *   instance or an object inheriting its settings), whose settings a spread would drop or Next would replace. In a
 *   phase that compiles, the phase function throws when `elmera-intl.json` is missing or invalid, its catalogs lie
 *   outside Turbopack's root (Next cannot load them), `request` names the project directory or one above it, or a
 *   `turbopack.resolveAlias` key (exact, or a wildcard whose pattern matches) maps the request module.
 */
export function withIntl<C extends object & IntlNextConfig>(
  config: C & PlainObject,
  options: WithIntlOptions
): (phase: string) => C {
  requireSpreadable(config, "the config");
  if (config.turbopack !== undefined) {
    requireSpreadable(config.turbopack, "turbopack");
  }

  return (phase) => (COMPILING_PHASES.has(phase) ? extend(config, options) : config);
}

// The phases in which Next 16.4.6 compiles through Turbopack, and so loads the catalogs: `next build` and `next typegen`
// load the config with phase-production-build, `next dev` and a dev custom server with phase-development-server, and
// `next analyze` with phase-analyze. next.test.ts holds them against Next's own constants.
const COMPILING_PHASES: ReadonlySet<string> = new Set([
  "phase-production-build",
  "phase-development-server",
  "phase-analyze",
]);

// The config with the rule and the alias, in a phase that compiles: every read of the project happens here, and each
// problem with it throws.
function extend<C extends object & IntlNextConfig>(config: C, options: WithIntlOptions): C {
  const configPath = resolve(options.dir, options.config ?? CONFIG_FILE);
  const loaded = loadConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    throw new Error(`withIntl: ${loaded.problem.message}; ${loaded.problem.fix}`);
  }

  const root = turbopackRoot(config, options.dir);
  const path = catalogRule(loaded.config, root);
  const aliases = requestAliases(config, options);
  const existing = new Map<string, unknown>(Object.entries(config.turbopack?.rules ?? {})).get(PO_GLOB);
  const roots = loaderRoots(config, root, options.dir);
  const loader: Omit<PoLoaderOptions, "source"> =
    roots === undefined ? { config: configPath } : { config: configPath, roots };
  const ours = [poRule(path, loader, true), poRule(path, loader, false)];
  const turbopack = {
    ...config.turbopack,
    rules: {
      ...config.turbopack?.rules,
      [PO_GLOB]: [...(existing === undefined ? [] : [existing].flat()), ...ours],
    },
  };

  return {
    ...config,
    turbopack: aliases === undefined ? turbopack : { ...turbopack, resolveAlias: aliases },
  };
}

// The settings withIntl spreads: the config and its `turbopack`.
type SpreadSettings = IntlNextConfig | NonNullable<IntlNextConfig["turbopack"]>;

// withIntl spreads the config and its `turbopack` into new objects, which copies only own enumerable data: a function
// (Next's phase-function config), an array, a class instance or an object inheriting its settings would lose its call,
// its shape, its getter and method settings or its inherited ones, and a thenable, plain or not, would hand its copied
// `then` to Next, which awaits the result and loads what that settles to instead of withIntl's rule and alias. The types reject most of these; this covers what they cannot
// see: a JavaScript next.config.mjs (which may pass anything, `null` included), a wrapper generic over NextConfig
// passing a decorated function, a class instance.
function requireSpreadable(value: SpreadSettings, name: string): void {
  const fix =
    "; pass the config object itself, and for a phase function call withIntl's result inside it: `export default async (phase, context) => withIntl(await config(phase, context), options)(phase)`";

  if (Object(value) !== value) {
    // What an untyped config passed: a string quoted, any other primitive as String prints it (JSON writes no BigInt
    // and no symbol).
    const primitive: unknown = value;
    const shown = String(primitive) === primitive ? JSON.stringify(primitive) : String(primitive);

    throw new Error(`withIntl: ${name} is ${shown}, not an object${fix}`);
  }

  // A callable `then`, own or inherited, is what Next awaits. Callability is read from `typeof`, which no property can
  // spoof (a `Symbol.toStringTag` can relabel the built-in tag) and which holds for a function of any realm.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- requireSpreadable is the boundary that parses untyped next.config values, and only typeof decides callability unspoofably across realms
  if ("then" in value && typeof value.then === "function") {
    throw new Error(`withIntl: ${name} is a thenable, which Next would await in place of the result${fix}`);
  }

  if (!isPlainObject(value)) {
    throw new Error(`withIntl: ${name} is ${unspreadable(value)}, whose settings a spread would drop${fix}`);
  }
}

// Whether an object is plain in any realm: a null prototype, or the `Object.prototype` of some realm (a config built by
// `vm.runInNewContext`, or cloned across realms as Vitest's vmForks pool does, has another realm's, not this one's).
// That prototype is recognised through its realm's native `Object`: it ends the chain, and its own `constructor` is a
// native function named `Object` whose `prototype` is it. A null-prototype record, or the prototype of a class that
// extends null, ends the chain too but has no such constructor; a class instance, a function or an array has a
// prototype with a prototype of its own. The constructor is read as a data property, so no getter runs.
function isPlainObject(value: SpreadSettings): boolean {
  const prototype = Reflect.getPrototypeOf(value);

  if (prototype === null) {
    return true;
  }

  const constructor: unknown = Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value;

  return (
    Reflect.getPrototypeOf(prototype) === null &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- requireSpreadable is the boundary that parses untyped next.config values, and only typeof decides callability unspoofably across realms
    typeof constructor === "function" &&
    Reflect.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype &&
    NATIVE_OBJECT.test(Function.prototype.toString.call(constructor))
  );
}

// The source text every engine gives a realm's built-in `Object` constructor, the NativeFunction form of ECMA-262. A
// user function, a class and a bound function each read otherwise.
const NATIVE_OBJECT = /^function Object\(\) \{\s*\[native code\]\s*\}$/u;

// What an object withIntl cannot spread is, for the error.
function unspreadable(value: SpreadSettings): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- requireSpreadable is the boundary that parses untyped next.config values, and only typeof decides callability unspoofably across realms
  if (typeof value === "function") {
    return "a function";
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  // A class's prototype has its own `constructor` function; a bare record used as a prototype has none.
  const prototype = Reflect.getPrototypeOf(value);
  const constructor: unknown =
    prototype === null ? undefined : Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- requireSpreadable is the boundary that parses untyped next.config values, and only typeof decides callability unspoofably across realms
  return typeof constructor === "function"
    ? "a class instance"
    : "an object inheriting another object's settings";
}

// The app's Turbopack aliases with the request module's added, or none to add when the app has no request module at
// the default path (an app that uses withIntl for its catalogs alone; the runtime's stub explains on first use). The
// reserved specifier is checked first, whether or not withIntl writes it: an entry an app or another wrapper wrote,
// exact or a wildcard key whose pattern matches it (Turbopack's `*` matches any run of characters), would otherwise
// replace the app's module, or stand in for one withIntl does not know; withIntl's own result is a function, which it
// refuses, so no entry is its own. The target is relative to the Next project directory, where Turbopack resolves
// relative alias targets (a bare path would read as a package name), with forward slashes on every platform. Whether it
// lies in Turbopack's root is not checked here: next.config loads again under `next start` (a pruned deployment carries
// the build without its source), behind symlinks and beside `experimental.turbopackAdditionalRoots`, where no check from
// here matches what Turbopack resolves; a target it cannot load leaves the stub, whose error names the cause.
function requestAliases(config: IntlNextConfig, options: WithIntlOptions) {
  const aliases = new Map<string, unknown>(Object.entries(config.turbopack?.resolveAlias ?? {}));
  const target = requestTarget(options);
  const mapped = [...aliases].find(([key]) => mapsRequestModule(key));

  if (mapped !== undefined) {
    const [key, value] = mapped;

    throw new Error(
      `withIntl: turbopack.resolveAlias maps ${REQUEST_MODULE}${key === REQUEST_MODULE ? "" : ` (through ${JSON.stringify(key)})`} to ${JSON.stringify(value)}, which withIntl reserves; remove that entry and set withIntl's \`request\` option instead`
    );
  }

  return target === undefined ? undefined : Object.fromEntries(aliases.set(REQUEST_MODULE, target));
}

// Whether a resolveAlias key applies to the request module's specifier: the key itself, or a wildcard key whose
// pattern (each `*` any run of characters, everything else literal) matches it.
function mapsRequestModule(key: string): boolean {
  return (
    key === REQUEST_MODULE ||
    (key.includes("*") &&
      new RegExp(
        `^${key
          .split("*")
          .map((part) => escape(part))
          .join(".*")}$`,
        "u"
      ).test(REQUEST_MODULE))
  );
}

// The alias target for the app's request module: `request` always, else the default path when that file exists.
function requestTarget(options: WithIntlOptions): string | undefined {
  const file = resolve(options.dir, options.request ?? DEFAULT_REQUEST);

  if (options.request === undefined && statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    return undefined;
  }

  if (isBelow(file, resolve(options.dir))) {
    throw new Error(
      `withIntl: the request module ${file} is the project directory or one above it; set \`request\` to the module's file, such as ${DEFAULT_REQUEST}`
    );
  }

  const below = relative(options.dir, file).split(sep).join("/");

  return below.startsWith("../") ? below : `./${below}`;
}

function poRule(path: RegExp, loader: Omit<PoLoaderOptions, "source">, source: boolean) {
  const options: PoLoaderOptions = { ...loader, source };

  return {
    condition: {
      all: [{ not: "foreign" }, { path }, source ? { query: "?source" } : { not: { query: "?source" } }],
    },
    loaders: [{ loader: fileURLToPath(new URL("./po-loader.js", import.meta.url)), options }],
    as: "*.js",
  };
}

// Turbopack's root as Next 16.4 sets it (server/config.js), and the setting that decides it: `outputFileTracingRoot`
// (Next uses it over `turbopack.root`, warning when they differ), else `turbopack.root`, else Next's own detection from the project directory (lib/find-root.js: the topmost workspace marker or lockfile, bounded by
// the git repository and the home directory), called rather than ported so the root always matches the installed Next.
// Relative settings resolve against the working directory, as Next's do (a bare `resolve()`). Next's private
// NEXT_PRIVATE_OUTPUT_TRACE_ROOT override, which replaces the detection, is left out: no build here sets it.
function turbopackRoot(config: IntlNextConfig, app: string): TurbopackRoot {
  if (config.outputFileTracingRoot !== undefined && config.outputFileTracingRoot !== "") {
    return { root: resolve(config.outputFileTracingRoot), setting: "outputFileTracingRoot" };
  }

  if (config.turbopack?.root !== undefined && config.turbopack.root !== "") {
    return { root: resolve(config.turbopack.root), setting: "turbopack.root" };
  }

  // SAFETY: Next's own module (unexported, so untyped), present in every Next >= 16.4 that runs this config; the
  // next.test.ts root cases go red if its shape changes.
  const { findRootDirAndLockFiles } = createRequire(join(app, "package.json"))(
    "next/dist/lib/find-root.js"
  ) as {
    readonly findRootDirAndLockFiles: (dir: string) => { readonly rootDir: string };
  };

  return { root: findRootDirAndLockFiles(app).rootDir, setting: "turbopack.root" };
}

// The settings loaderRoots reads, as an untyped next.config.mjs may hold them: anything, a getter that throws included.
type LoaderRootsConfig = IntlNextConfig & {
  readonly adapterPath?: unknown;
  readonly experimental?: {
    readonly adapterPath?: unknown;
    readonly turbopackAdditionalRoots?: Readonly<Record<string, { readonly path?: unknown } | null>> | null;
  } | null;
};

// The roots the PO loader checks its dependencies against, or none when Next selects an adapter (`adapterPath`,
// `experimental.adapterPath`, or Next's default for it, NEXT_ADAPTER_PATH as config-shared.js read it when Next loaded
// it): Next runs an adapter's `modifyConfig` after it evaluates next.config, and it may add roots. None too when a
// setting cannot be read (a getter that throws, no Next installed in `app`): withIntl stays total and errs towards
// accepting. The settings are read by name, before Next's module: Next's config clone keeps non-enumerable ones.
function loaderRoots(
  config: LoaderRootsConfig,
  root: TurbopackRoot,
  app: string
): TurbopackRoots | undefined {
  try {
    const selected = Boolean(config.adapterPath) || Boolean(config.experimental?.adapterPath);
    const additional = additionalRoots(config.experimental?.turbopackAdditionalRoots ?? {});
    // SAFETY: Next's own module (unexported, so untyped), present in every Next >= 16.4 that runs this config; the
    // po-loader.test.ts refusal rows go red if its shape changes (the catch then passes no roots).
    const { defaultConfig } = createRequire(resolve(app, "package.json"))(
      "next/dist/server/config-shared.js"
    ) as {
      readonly defaultConfig: { readonly adapterPath?: string };
    };

    return selected || Boolean(defaultConfig.adapterPath) ? undefined : { ...root, additional };
  } catch {
    return undefined;
  }
}

// The directories `experimental.turbopackAdditionalRoots` names, read as Next reads them: its config clone
// (server/config.js, cloneObject) keeps every own key, non-enumerable data properties made enumerable, before
// build/swc reads the entries and their `path`. Each resolves from the working directory through its links
// (crates/next-api/src/additional_roots.rs); one that does not resolve yet (made later in the build) is kept as
// written, absolute; an entry of no `{ path }` string is left out. Every other entry counts, though Next drops some
// (one missing when Turbopack starts, one that overlaps the root or an earlier one): a file there then misses a
// refusal, never gets a false one.
function additionalRoots(
  entries: NonNullable<NonNullable<LoaderRootsConfig["experimental"]>["turbopackAdditionalRoots"]>
): ReadonlyArray<string> {
  return Object.getOwnPropertyNames(entries).flatMap((key) => {
    const path = entries[key]?.path;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- additionalRoots parses untyped next.config values, and typeof reads a string without coercing an object (String() of a null-prototype object throws)
    return typeof path === "string" && path !== "" ? [canonical(path) ?? resolve(path)] : [];
  });
}

// The catalogs' rule path. Turbopack matches a rule's path against the module's path below its root after resolving its
// links (replayed on Next 16.4.6 for #63: a link inside the root matches at its target, never as written), so the
// pattern is the catalogs' real path below the root's (the catalog import finds the file it is handed at its real path,
// project-catalogs.ts).
// Catalogs written inside the root through a link out of it keep the pattern as written, unrefused: Turbopack refuses
// that import itself (`the symlink target leaves the configured filesystem roots`), and a webpack loader cannot run in
// an additional root, so a refusal here would add nothing.
function catalogRule(config: ProjectConfig, { root, setting }: TurbopackRoot): RegExp {
  const catalogs = resolve(config.root, config.catalogs);
  const real = realPath(catalogs);
  const realRoot = canonical(root) ?? root;

  if (isBelow(realRoot, real)) {
    return catalogPathPattern(relative(realRoot, real));
  }

  if (!isBelow(root, catalogs)) {
    throw new Error(
      `withIntl: the catalogs ${config.catalogs} are outside the Turbopack root ${root}, which resolves no file outside it; set ${setting} to a directory that holds both the app and the catalogs`
    );
  }

  return catalogPathPattern(relative(root, catalogs));
}

// The catalogs pattern as a RegExp over the path Turbopack matches: the catalog's path relative to its root, with
// `{locale}` one path segment. Only regex metacharacters are escaped, with plain backslashes (not RegExp.escape's hex
// escapes): Turbopack evaluates the pattern in its own engine.
function catalogPathPattern(below: string): RegExp {
  const pattern = below
    .split(sep)
    .join("/")
    .split("{locale}")
    .map((part) => escape(part))
    .join("[^/]+");

  // oxlint-disable-next-line require-unicode-regexp -- Turbopack evaluates this pattern's source in its own engine, not as a JS RegExp, so a JS flag is not part of what it reads
  return new RegExp(`^${pattern}$`);
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
