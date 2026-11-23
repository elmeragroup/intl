import { spawnSync } from "node:child_process";
// A project the CLI works on: its formats, its catalogs and the messages its sources declare (project-config.ts reads
// its config).
import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { Formats } from "@elmeragroup/intl/internal/icu";

import { extractMessages } from "./extract";
import type { Problem } from "./problem";
import type { ProjectConfig } from "./project-config";
import { CONFIG_FILE } from "./project-config";

/**
 * Extraction results by project-relative path, each with its source's content hash, so a rescan parses only changed
 * files. `scanProject` drops entries for files no longer scanned.
 */
export type ParseCache = Map<
  string,
  { readonly hash: string; readonly result: ReturnType<typeof extractMessages> }
>;

/** A message and every file that uses it. */
export type ProjectMessage = {
  readonly key: string;
  readonly source: string;
  readonly context: string | undefined;
  readonly references: ReadonlyArray<string>;
  readonly comments: ReadonlyArray<string>;
};

/**
 * Load the app's `formats` from the module the config names. Node loads it (type stripping for TypeScript), so the
 * module must import nothing at runtime: a `satisfies Formats` object, with type-only imports, whose options are
 * JSON values. Reloaded whenever the module's content changes, so a long-lived dev server or watch build validates
 * what the app now imports.
 *
 * @param config - The project config.
 * @returns The formats (undefined when the config names none), or why the module does not provide them.
 */
export function loadFormats(
  config: ProjectConfig
):
  | { readonly _tag: "Formats"; readonly formats: Formats | undefined }
  | { readonly _tag: "ConfigInvalid"; readonly problem: Problem } {
  if (config.formats === undefined) {
    return { _tag: "Formats", formats: undefined };
  }

  const file = relative(config.root, config.formats);
  const invalid = (message: string) => ({
    _tag: "ConfigInvalid" as const,
    problem: {
      code: "FormatsInvalid",
      message,
      fix: `export the app's formats as \`export const formats = { … } satisfies Formats\` from ${file}, importing types only`,
      file,
    },
  });
  const loaded = evaluateFormats(config.formats);

  if (loaded._tag === "FormatsUnloadable") {
    return invalid(`cannot load: ${loaded.reason}`);
  }

  const { exported, nonJson } = loaded;

  // The formats reach the runtime through JSON, which turns Infinity into null (Intl then throws "out of range") and a
  // Date into a string; validating the module's own values would pass what the app never receives.
  if (nonJson !== undefined) {
    return invalid(
      `${nonJson}, which JSON does not carry: use a string, a finite number, a boolean, null, or an array or plain object of them`
    );
  }

  const fields =
    typeof exported === "object" && exported !== null
      ? new Map<string, unknown>(Object.entries(exported))
      : undefined;
  // The shape resolveFormats reads: optional dateTime, number and list maps of option objects. Intl validates the
  // options themselves when compileCatalog dry-formats with them.
  const isFormats =
    fields !== undefined &&
    [...fields].every(
      ([field, styles]) =>
        STYLE_KINDS.has(field) &&
        typeof styles === "object" &&
        styles !== null &&
        new Map<string, unknown>(Object.entries(styles))
          .values()
          .every((options) => typeof options === "object" && options !== null)
    );

  if (!isFormats) {
    return invalid("no `formats` export holding objects of named styles under dateTime, number or list");
  }

  // SAFETY: checked above to be an object whose dateTime, number and list fields map names to option objects, which
  // is Formats up to the option values, and compileCatalog's dry-format runs every style's options through Intl.
  return { _tag: "Formats", formats: exported as Formats };
}

const STYLE_KINDS = new Set(["dateTime", "number", "list"]);

// Prints the module's `formats` export as JSON (`{}` when it has none), with the first value inside it that JSON would
// drop or change, as "<path> is <what>": only this process sees the values before serialization.
const PRINT_FORMATS = `
const { formats } = await import(process.argv[1]);
const nonJson = (value, path) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : \`\${path} is \${value}\`;
  if (typeof value !== "object") return \`\${path} is \${value === undefined ? "undefined" : \`a \${typeof value}\`}\`;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return \`\${path} is a \${prototype.constructor?.name ?? "class instance"}\`;
  for (const [key, inner] of Object.entries(value)) {
    const found = nonJson(inner, \`\${path}.\${key}\`);
    if (found !== undefined) return found;
  }
  return undefined;
};
const found = formats === undefined ? undefined : nonJson(formats, "formats");
process.stdout.write(JSON.stringify(found === undefined ? { formats } : { nonJson: found }));
`;

// The last evaluation per module path, keyed by the content it evaluated: a per-process memo of a pure function of
// that content, so an edit evaluates again and an unchanged module costs one read.
const EVALUATED = new Map<string, { readonly content: string; readonly result: Evaluated }>();

type Evaluated =
  | { readonly _tag: "Evaluated"; readonly exported: unknown; readonly nonJson: string | undefined }
  | { readonly _tag: "FormatsUnloadable"; readonly reason: string };

// A fresh Node evaluates the module: Node's module cache, which require and import share, never evicts an ES module, so
// an in-process load would keep the first content for the life of a dev server. Synchronous, so check stays so.
function evaluateFormats(path: string): Evaluated {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return { _tag: "FormatsUnloadable", reason: error instanceof Error ? error.message : String(error) };
  }

  const hit = EVALUATED.get(path);

  if (hit?.content === content) {
    return hit.result;
  }

  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", PRINT_FORMATS, pathToFileURL(path).href],
    // The host's NODE_OPTIONS (an inspector port, a loader) belong to the host, not to this evaluation.
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
  );
  const result: Evaluated =
    child.error === undefined
      ? parseEvaluation(child.status, child.stdout, child.stderr)
      : { _tag: "FormatsUnloadable", reason: child.error.message };
  EVALUATED.set(path, { content, result });

  return result;
}

function parseEvaluation(status: number | null, stdout: string, stderr: string): Evaluated {
  if (status !== 0) {
    // The error line, not Node's stack and source excerpt around it.
    const reason = stderr.split("\n").find((line) => /^\w*Error\b/u.test(line)) ?? stderr.trim();

    return { _tag: "FormatsUnloadable", reason };
  }

  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    return { _tag: "FormatsUnloadable", reason: "the module writes to stdout when loaded" };
  }

  const fields =
    typeof printed === "object" && printed !== null
      ? new Map<string, unknown>(Object.entries(printed))
      : undefined;
  const nonJson = fields?.get("nonJson");

  return {
    _tag: "Evaluated",
    exported: fields?.get("formats"),
    nonJson: typeof nonJson === "string" ? nonJson : undefined,
  };
}

/**
 * Whether a source file belongs to the project: under the root, outside `node_modules`, matched by an include
 * pattern, and neither it nor a directory above it matched by an exclude pattern. Extraction and the watcher both
 * decide membership here.
 *
 * @param config - The project config.
 * @param file - An absolute path.
 * @returns `true` when the file is a project source.
 */
export function isProjectSource(config: ProjectConfig, file: string): boolean {
  const path = relative(config.root, file).split(sep).join("/");
  const segments = path.split("/");
  // Directories as `dir/`: the form that matches `src/skip`, `src/skip/` and `src/skip/**` alike, like globSync's
  // exclude, which prunes a matching directory during the walk.
  const candidates = [
    path,
    ...segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join("/")}/`),
  ];

  return (
    !path.startsWith("../") &&
    !isAbsolute(path) &&
    !segments.includes("node_modules") &&
    config.include.some((pattern) => matchesGlob(path, pattern)) &&
    !candidates.some((candidate) => config.exclude.some((pattern) => matchesGlob(candidate, pattern)))
  );
}

/**
 * Whether a directory holds no project source: it is or lies in `node_modules`, or the config excludes it (as
 * `isProjectSource` and the extract walk prune it).
 *
 * @param config - The project config.
 * @param directory - An absolute directory path.
 * @returns `true` when nothing under the directory can be a project source.
 */
export function isExcludedDirectory(config: ProjectConfig, directory: string): boolean {
  const path = relative(config.root, directory).split(sep).join("/");
  const segments = path.split("/");
  const candidates = segments.map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);

  return (
    segments.includes("node_modules") ||
    candidates.some((candidate) => config.exclude.some((pattern) => matchesGlob(candidate, pattern)))
  );
}

/**
 * Path of a locale's PO file.
 *
 * @param config - The project config.
 * @param locale - The locale.
 * @returns The absolute path.
 */
export function catalogPath(config: ProjectConfig, locale: string): string {
  const pattern = config.catalogs.replaceAll("{locale}", locale);

  return isAbsolute(pattern) ? pattern : join(config.root, pattern);
}

/**
 * The configured locale a PO file is the catalog of: what a loader compiles an imported `.po` for.
 *
 * @param config - The project config.
 * @param file - An absolute path.
 * @returns The locale, or undefined when the file is not one of the configured locales' catalogs.
 */
export function catalogLocale(config: ProjectConfig, file: string): string | undefined {
  return config.locales.find((locale) => resolve(catalogPath(config, locale)) === resolve(file));
}

/**
 * Extract every message of the project's sources.
 *
 * @param config - The project config.
 * @param cache - Parse results from earlier scans; updated in place.
 * @returns The messages by key (in first-seen order) and the include patterns that match no file, or every
 * extraction problem.
 */
export function scanProject(
  config: ProjectConfig,
  cache: ParseCache = new Map()
):
  | {
      readonly _tag: "Scanned";
      readonly messages: ReadonlyArray<ProjectMessage>;
      /** `IncludeUnmatched` problems: `check` reports them, `extract` refuses to write. */
      readonly unmatched: ReadonlyArray<Problem>;
    }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<Problem> } {
  // Per pattern, so a pattern that stopped matching (a renamed directory) is reported instead of its messages
  // silently leaving the catalogs. glob's `exclude` only prunes the walk (it skips what isProjectSource rejects);
  // isProjectSource decides. globSync also returns directories (a folder named `x.tsx`).
  const matches = config.include.map((pattern) => ({
    pattern,
    files: globSync(pattern, { cwd: config.root, exclude: ["**/node_modules/**", ...config.exclude] }).filter(
      (file) =>
        isProjectSource(config, join(config.root, file)) &&
        // A dangling symlink has no stat: skip it like a directory.
        statSync(join(config.root, file), { throwIfNoEntry: false })?.isFile() === true
    ),
  }));
  const unmatched = matches
    .filter(({ files }) => files.length === 0)
    .map(({ pattern }) => ({
      code: "IncludeUnmatched",
      message: `include pattern ${JSON.stringify(pattern)} matches no file`,
      fix: `fix or remove the pattern in ${CONFIG_FILE}`,
      file: CONFIG_FILE,
    }));
  const files = [...new Set(matches.flatMap((match) => match.files))].toSorted();
  const problems: Array<Problem> = [];
  const byKey = new Map<
    string,
    { source: string; context: string | undefined; references: Set<string>; comments: Set<string> }
  >();
  const scannedPaths = new Set<string>();
  for (const file of files) {
    const path = relative(config.root, join(config.root, file)).split("\\").join("/");
    scannedPaths.add(path);
    const result = cachedExtract(cache, path, readFileSync(join(config.root, file), "utf8"));

    if (result._tag === "Failed") {
      problems.push(
        ...result.failures.map((failure) => ({
          code: "ExtractFailed",
          message: failure.message,
          fix: "rewrite the call in an allowed form (see the extraction contract in @elmeragroup/intl's README)",
          file: path,
          line: failure.position.line,
          column: failure.position.column,
        }))
      );
      continue;
    }

    for (const message of result.messages) {
      if (message.source === "") {
        problems.push({
          code: "EmptyMessage",
          message: "empty message (an empty msgid would collide with the PO header)",
          fix: "give the message text, or remove the call",
          file: path,
        });
        continue;
      }

      const entry = byKey.get(message.key) ?? {
        source: message.source,
        context: message.context,
        references: new Set<string>(),
        comments: new Set<string>(),
      };
      entry.references.add(path);
      message.tags.forEach((tag) => entry.comments.add(tag));
      byKey.set(message.key, entry);
    }
  }

  for (const path of cache.keys()) {
    if (!scannedPaths.has(path)) {
      cache.delete(path);
    }
  }

  if (problems.length > 0) {
    return { _tag: "Failed", problems: [...unmatched, ...problems] };
  }

  const messages = [...byKey].map(([key, entry]) => ({
    key,
    source: entry.source,
    context: entry.context,
    references: [...entry.references].toSorted(),
    comments: [...entry.comments].toSorted(),
  }));

  return { _tag: "Scanned", messages, unmatched };
}

function cachedExtract(cache: ParseCache, path: string, text: string): ReturnType<typeof extractMessages> {
  const hash = createHash("sha1").update(text).digest("base64");
  const hit = cache.get(path);

  if (hit?.hash === hash) {
    return hit.result;
  }

  const result = extractMessages(path, text);
  cache.set(path, { hash, result });

  return result;
}
