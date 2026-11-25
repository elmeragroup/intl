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

// A path's separators, both: a config is read on POSIX and Windows hosts alike, and a POSIX file name holding a
// backslash before `..` is no catalog anyone writes.
const SEPARATOR = /[\\/]/u;
const ALIASING = "a directory the sync creates could make two locales' paths name one catalog";

// The problem with a `catalogs` pattern that climbs out of a directory named after the locale.
const CLIMBING_CATALOGS = `"catalogs" must not hold a ".." segment anywhere after the first segment holding {locale} (${ALIASING})`;

/**
 * The problem with catalog paths that two locales could share: a locale that is no locale identifier
 * `Intl.getCanonicalLocales` accepts (a subset of BCP 47: `en-GB-oed`, a grandfathered tag, is refused), two locales
 * that are one identifier (compared canonically: `nb` and `NB`, `iw` and `he`), or any `..` segment after the first
 * segment that holds `{locale}`, however far after. A locale names its catalog file, the PO's `Language` header and how
 * its messages format, so it must be an identifier; a path-like value (`/nb`, `../messages/nb`) would name another locale's catalog through another
 * string. Only a `..` after the locale can cancel the one part of a path that differs between locales, so only there
 * can a directory the sync creates for one locale make its path reach a catalog another locale's path names, after the
 * write guard read it as absent (#18); a `..` before the locale is the same for every locale and stays valid. With
 * these, each locale's catalog path is a string of its own: identifiers hold no separator and no `.` segment, and two whose
 * canonical forms differ also differ once case-folded, so no case-insensitive file system folds them into one name.
 * The spelling is kept as written (`en-us` stays valid): it is the catalog's file name.
 *
 * @param catalogs - The `catalogs` pattern, holding `{locale}`.
 * @param locales - The configured locales.
 * @returns What the problem says, or undefined when every locale's path is its own.
 */
export function sharedCatalogPath(catalogs: string, locales: ReadonlyArray<string>): string | undefined {
  const tags = new Map<string, string>();
  for (const locale of locales) {
    const tag = canonicalTag(locale);

    if (tag === undefined) {
      return `locale ${JSON.stringify(locale)} is not a locale identifier Intl.getCanonicalLocales accepts (such as "nb" or "pt-BR"): it names the locale's catalog and how its messages format`;
    }

    const earlier = tags.get(tag.toLowerCase());

    if (earlier !== undefined) {
      return earlier === locale
        ? `locale ${JSON.stringify(locale)} is listed twice: each locale needs a catalog of its own`
        : `locales ${JSON.stringify(earlier)} and ${JSON.stringify(locale)} are one locale identifier, ${tag}: each locale needs a catalog of its own`;
    }

    tags.set(tag.toLowerCase(), locale);
  }

  const segments = catalogs.split(SEPARATOR);
  // The pattern holds `{locale}`, which holds no separator, so one segment holds it.
  const first = segments.findIndex((segment) => segment.includes("{locale}"));

  return segments.slice(first + 1).includes("..") ? CLIMBING_CATALOGS : undefined;
}

// A locale's canonical identifier, or undefined when Intl.getCanonicalLocales refuses it (a RangeError).
function canonicalTag(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

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
  return snapshotConfig(path).loaded;
}

/** One read of the project config: the text read, and the config parsed from that same text. */
export type ConfigSnapshot = {
  /** The file's text; none when it is missing or cannot be read. */
  readonly text: string | undefined;
  /** The config parsed from `text`, or the problem with it. */
  readonly loaded: ConfigLoaded;
};

/**
 * `loadConfig`, keeping the text it read: a host that compares one read with the next acts on exactly the config it
 * compared, never on a later read of the file.
 *
 * @param path - Path of `elmera-intl.json`, as the problems name it.
 * @returns The text and the config parsed from it.
 */
export function snapshotConfig(path: string): ConfigSnapshot {
  if (!existsSync(path)) {
    return { text: undefined, loaded: configInvalid(path, `${path} not found`) };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A read failure (a directory, no permission) reads as "not JSON", as it did when the read and the parse shared
    // one try: the CLI's output stays as it was.
    return {
      text: undefined,
      loaded: configInvalid(path, `not JSON: ${error instanceof Error ? error.message : String(error)}`),
    };
  }

  return { text, loaded: parseConfig(text, path, dirname(resolve(path))) };
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

  const shared = sharedCatalogPath(catalogs, locales);

  if (shared !== undefined) {
    return configInvalid(path, shared);
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
