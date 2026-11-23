// The project config, `elmera-intl.json`: its parse, a pure function of the file's text, and the synchronous read
// `withIntl` needs (Next calls it inside next.config, which returns synchronously). A leaf beside problem.ts, so
// next.config loads neither the extractor nor the rest of the project module.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";

import type { Problem } from "./problem";

/** The config file name the CLI looks for in the project root. */
export const CONFIG_FILE = "elmera-intl.json";

/** A parsed `elmera-intl.json`. */
export type ProjectConfig = {
  /** The directory paths in the config are relative to. */
  readonly root: string;
  /** Glob patterns of source files to extract, root-relative and normalized (`parseConfig` drops a leading `./`). */
  readonly include: ReadonlyArray<string>;
  /** Glob patterns to skip, normalized like `include`; `node_modules` is always skipped. */
  readonly exclude: ReadonlyArray<string>;
  /** Catalog path pattern with a `{locale}` placeholder, ending in `.po`. */
  readonly catalogs: string;
  /** Locales to keep catalogs for; the source (English) needs none, its catalog compiles from any PO's msgids. */
  readonly locales: ReadonlyArray<string>;
  /**
   * Absolute path of the module whose `formats` export is the app's `formats`, when the app has any. The runtime
   * adapter imports it, and `check` and the loaders load it, so all three validate and format with one definition.
   */
  readonly formats: string | undefined;
};

/** A config file read and parsed: the config, or the one problem with it. */
export type ConfigLoaded =
  | { readonly _tag: "Config"; readonly config: ProjectConfig }
  | { readonly _tag: "ConfigInvalid"; readonly problem: Problem };

const CONFIG_EXAMPLE =
  '{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb"], "formats": "src/intl-formats.ts" }';

/** What a `formats` path must end in: a module Node loads. */
export const FORMATS_MODULE = /\.(?:ts|mts|js|mjs)$/u;

/** What each config field must be, as its problem says it. */
export const FIELD_PROBLEMS = {
  include: '"include" must be a non-empty array of glob strings',
  exclude: '"exclude" must be an array of glob strings',
  locales: '"locales" must be a non-empty array of locale strings',
  catalogs: '"catalogs" must be a path pattern with {locale} ending in .po',
  formats: '"formats" must be the path of a .ts or .js module exporting `formats`',
} as const;

/**
 * The problem with a glob that reaches outside the project root.
 *
 * @param pattern - The glob, normalized.
 * @returns What the problem says.
 */
export function escapingGlob(pattern: string): string {
  return `glob ${JSON.stringify(pattern)} reaches outside the project root`;
}

/**
 * The first glob that reaches outside the project root: absolute, or climbing out with `../`.
 *
 * @param patterns - The globs, normalized.
 * @returns The first escaping glob, or undefined when none escapes.
 */
export function firstEscaping(patterns: ReadonlyArray<string>): string | undefined {
  return patterns.find((pattern) => isAbsolute(pattern) || pattern.startsWith("../"));
}

/**
 * The `ConfigInvalid` problem with a config.
 *
 * @param path - The config's path, as the problem names it.
 * @param message - What is wrong.
 * @returns The problem, with the fix every config problem names.
 */
export function configInvalid(path: string, message: string): ConfigLoaded {
  return {
    _tag: "ConfigInvalid",
    problem: { code: "ConfigInvalid", message, fix: `write ${CONFIG_FILE} as ${CONFIG_EXAMPLE}`, file: path },
  };
}

/**
 * Read and parse the project config, synchronously. The read is the boundary that resolves a relative path, against
 * the working directory; every caller passes an absolute one.
 *
 * @param path - Path of `elmera-intl.json`, as the problems name it.
 * @returns The config, or the problem with it.
 */
export function loadConfig(path: string): ConfigLoaded {
  if (!existsSync(path)) {
    return configInvalid(path, `${path} not found`);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A read failure (a directory, no permission) reads as "not JSON", as it did when the read and the parse shared
    // one try: the CLI's output stays as it was.
    return configInvalid(path, `not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parseConfig(text, path, dirname(resolve(path)));
}

/**
 * Parse the project config from the file's text.
 *
 * @param text - The content of `elmera-intl.json`.
 * @param path - Its path as the user supplied it: the problems name it verbatim.
 * @param root - The absolute directory holding it, which the config's paths are relative to. The read boundary
 *   resolves it, so the result is a function of the arguments alone, never of the working directory.
 * @returns The config, or the problem with it.
 */
export function parseConfig(text: string, path: string, root: string): ConfigLoaded {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return configInvalid(path, `not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof raw !== "object" || raw === null) {
    return configInvalid(path, "not a JSON object");
  }

  const fields = new Map<string, unknown>(Object.entries(raw));
  // Normalized once here so `./src/**` matches `src/page.ts` wherever membership is decided (isProjectSource).
  const include = stringListField(fields, "include")?.map((pattern) => posix.normalize(pattern));
  const exclude = fields.has("exclude")
    ? stringListField(fields, "exclude")?.map((pattern) => posix.normalize(pattern))
    : [];
  const locales = stringListField(fields, "locales");
  const catalogs = fields.get("catalogs");
  const formats = fields.get("formats");

  if (include === undefined || include.length === 0) {
    return configInvalid(path, FIELD_PROBLEMS.include);
  }

  if (exclude === undefined) {
    return configInvalid(path, FIELD_PROBLEMS.exclude);
  }

  const escaping = firstEscaping([...include, ...exclude]);

  if (escaping !== undefined) {
    return configInvalid(path, escapingGlob(escaping));
  }

  if (locales === undefined || locales.length === 0) {
    return configInvalid(path, FIELD_PROBLEMS.locales);
  }

  if (typeof catalogs !== "string" || !catalogs.includes("{locale}") || !catalogs.endsWith(".po")) {
    return configInvalid(path, FIELD_PROBLEMS.catalogs);
  }

  if (formats !== undefined && (typeof formats !== "string" || !FORMATS_MODULE.test(formats))) {
    return configInvalid(path, FIELD_PROBLEMS.formats);
  }

  return {
    _tag: "Config",
    config: {
      root,
      include,
      exclude,
      catalogs,
      locales,
      // resolve, not join: an absolute formats path stays as written; the root is absolute, so no working directory.
      // The exception is win32's drive-relative form (`D:formats.ts`), which resolves against that drive's working
      // directory, as it always has: node:path has no cwd-free reading of it, and rejecting it would refuse configs
      // that load today.
      formats: formats === undefined ? undefined : resolve(root, formats),
    },
  };
}

function stringListField(fields: ReadonlyMap<string, unknown>, name: string): Array<string> | undefined {
  const value = fields.get(name);

  if (!Array.isArray(value)) {
    return undefined;
  }

  const items: Array<unknown> = value;

  return items.every((item): item is string => typeof item === "string") ? items : undefined;
}
