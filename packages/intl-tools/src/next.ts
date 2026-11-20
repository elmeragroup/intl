// Next.js hosting: `withIntl` adds the Turbopack rule that compiles `*.po` imports. Check and watch run as scripts
// (`elmera-intl check && next build`, `extract --watch` beside `next dev`), because Next loads its config in more than
// one process.
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProjectConfig } from "./project";
import { CONFIG_FILE, loadConfig } from "./project";

/** Options for `withIntl`. */
export type WithIntlOptions = {
  /**
   * The Next project directory: `import.meta.dirname` in `next.config.ts`. Next is resolved and its root detected from
   * here, not from `process.cwd()`, which differs from it under `next build <dir>`.
   */
  readonly dir: string;
  /** Path of `elmera-intl.json`, relative to `dir`; defaults to its `elmera-intl.json`. */
  readonly config?: string;
};

/**
 * The part of a Next config `withIntl` reads and extends, typed here so this package needs no `next` (a non-Next
 * host app's pruned install would then carry Next). The rule map stays opaque: Next owns its entries, and `withIntl` only appends
 * its rule beside them.
 */
export type IntlNextConfig = {
  /** Next's root for file tracing, which it also makes Turbopack's root. */
  readonly outputFileTracingRoot?: string;
  readonly turbopack?: {
    /** The directory Turbopack resolves files in and matches rule paths against. */
    readonly root?: string;
    readonly rules?: object;
  };
};

/** What the loader receives as options: JSON only. */
export type PoLoaderOptions = {
  /** Absolute path of `elmera-intl.json`. */
  readonly config: string;
  /** Compile the msgids as the English catalog (`?source`). */
  readonly source: boolean;
};

const PO_GLOB = "*.po";

/**
 * Add the `@elmeragroup/intl` Turbopack rule to a Next config: `import catalog from "./intl/no.po"` compiles the `no`
 * catalog and `"./intl/no.po?source"` the English one, in every layer, dev and build. The rule matches only the
 * configured catalogs' paths below Turbopack's root (as Next determines it), so another library's `*.po` rule
 * (next-intl's) keeps its files; an existing `*.po` key becomes an array with this rule appended.
 *
 * @template C - The app's config type.
 * @param config - The Next config.
 * @param options - The project directory, and where `elmera-intl.json` lives.
 * @returns The config with the rule.
 * @throws When `elmera-intl.json` is missing or invalid, or its catalogs lie outside Turbopack's root: Next cannot
 *   load the catalogs.
 */
export function withIntl<C extends IntlNextConfig>(config: C, options: WithIntlOptions): C {
  const configPath = resolve(options.dir, options.config ?? CONFIG_FILE);
  const loaded = loadConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    throw new Error(`withIntl: ${loaded.problem.message}; ${loaded.problem.fix}`);
  }

  const path = catalogPathPattern(loaded.config, turbopackRoot(config, options.dir));
  const existing = new Map<string, unknown>(Object.entries(config.turbopack?.rules ?? {})).get(PO_GLOB);
  const ours = [poRule(path, configPath, true), poRule(path, configPath, false)];

  return {
    ...config,
    turbopack: {
      ...config.turbopack,
      rules: {
        ...config.turbopack?.rules,
        [PO_GLOB]: [...(existing === undefined ? [] : [existing].flat()), ...ours],
      },
    },
  };
}

function poRule(path: RegExp, config: string, source: boolean) {
  const options: PoLoaderOptions = { config, source };

  return {
    condition: {
      all: [{ not: "foreign" }, { path }, source ? { query: "?source" } : { not: { query: "?source" } }],
    },
    loaders: [{ loader: fileURLToPath(new URL("./po-loader.js", import.meta.url)), options }],
    as: "*.js",
  };
}

// Turbopack's root as Next 16.4 sets it (server/config.js): `outputFileTracingRoot`, else `turbopack.root`, else Next's
// own detection from the project directory (lib/find-root.js: the topmost workspace marker or lockfile, bounded by
// the git repository and the home directory), called rather than ported so the root always matches the installed Next.
// Relative settings resolve against the working directory, as Next's do (a bare `resolve()`). Next's private
// NEXT_PRIVATE_OUTPUT_TRACE_ROOT override, which replaces the detection, is left out: no build here sets it.
function turbopackRoot(config: IntlNextConfig, app: string): string {
  const configured = [config.outputFileTracingRoot, config.turbopack?.root].find(
    (root) => root !== undefined && root !== ""
  );

  if (configured !== undefined) {
    return resolve(configured);
  }

  // SAFETY: Next's own module (unexported, so untyped), present in every Next >= 16.4 that runs this config; the
  // next.test.ts root cases go red if its shape changes.
  const { findRootDirAndLockFiles } = createRequire(join(app, "package.json"))(
    "next/dist/lib/find-root.js"
  ) as {
    readonly findRootDirAndLockFiles: (dir: string) => { readonly rootDir: string };
  };

  return findRootDirAndLockFiles(app).rootDir;
}

// The catalogs pattern as a RegExp over the path Turbopack matches: the catalog's path relative to its root, with
// `{locale}` one path segment. Only regex metacharacters are escaped, with plain backslashes (not RegExp.escape's hex
// escapes): Turbopack evaluates the pattern in its own engine.
function catalogPathPattern(config: ProjectConfig, root: string): RegExp {
  const below = relative(root, resolve(config.root, config.catalogs));

  if (below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) {
    throw new Error(
      `withIntl: the catalogs ${config.catalogs} are outside the Turbopack root ${root}, which resolves no file outside it; set turbopack.root to a directory that holds both the app and the catalogs`
    );
  }

  const pattern = below
    .split(sep)
    .join("/")
    .split("{locale}")
    .map((part) => escape(part))
    .join("[^/]+");

  return new RegExp(`^${pattern}$`);
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
