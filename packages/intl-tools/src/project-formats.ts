// The app's `formats` module, loaded as the runtime gets it. A leaf, so the loaders (Next's po-loader, Vite's `load`)
// compile a catalog with the app's formats without loading the extractor or Effect. Its evaluation and judgment are
// shared with `ProjectFormats` (project-formats-service.ts), which loads them for the hosts' Effect runtimes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";

import type { Formats } from "@elmeragroup/intl/internal/icu";

import type { Problem } from "./problem";
import type { ProjectConfig } from "./project-config";

/** The app's formats, or why its module does not provide them. */
export type FormatsLoaded =
  | { readonly _tag: "Formats"; readonly formats: Formats | undefined }
  | { readonly _tag: "ConfigInvalid"; readonly problem: Problem };

/**
 * Load the app's `formats` from the module the config names. Node loads it (type stripping for TypeScript), so the
 * module must import nothing at runtime: a `satisfies Formats` object, with type-only imports, whose options are
 * JSON values. Reloaded whenever the module's content changes, so a long-lived dev server or watch build validates
 * what the app now imports. Synchronous, with a memo for the process: the loaders' path, which has no runtime.
 *
 * @param config - The project config.
 * @returns The formats (undefined when the config names none), or why the module does not provide them.
 */
export function loadFormats(config: ProjectConfig): FormatsLoaded {
  return config.formats === undefined
    ? { _tag: "Formats", formats: undefined }
    : judgeFormats(config.root, config.formats, evaluateFormats(config.formats));
}

/**
 * Judge an evaluation of the config's formats module: the formats, or the problem with them.
 *
 * @param root - The project root, which the problem names the module from.
 * @param module - The module's absolute path.
 * @param loaded - What evaluating it gave.
 * @returns The formats, or the `FormatsInvalid` problem.
 */
export function judgeFormats(root: string, module: string, loaded: Evaluated): FormatsLoaded {
  const file = relative(root, module);
  const invalid = (message: string) => ({
    _tag: "ConfigInvalid" as const,
    problem: {
      code: "FormatsInvalid",
      message,
      fix: `export the app's formats as \`export const formats = { … } satisfies Formats\` from ${file}, importing types only`,
      file,
    },
  });
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

/**
 * The Node arguments that evaluate a formats module and print its `formats` export as JSON.
 *
 * @param path - The module's absolute path.
 * @returns The arguments after Node's executable.
 */
export function evaluationArgs(path: string): Array<string> {
  return ["--input-type=module", "--eval", PRINT_FORMATS, pathToFileURL(path).href];
}

/** The last evaluation of each module path, keyed by the content it evaluated. */
export type FormatsMemo = Map<string, { readonly content: string; readonly result: Evaluated }>;

// The loaders' memo: per process, of a pure function of the content, so an edit evaluates again and an unchanged
// module costs one read.
const EVALUATED: FormatsMemo = new Map();

/** What evaluating a formats module gave: its export and the first value JSON would not carry, or why it failed. */
export type Evaluated =
  | { readonly _tag: "Evaluated"; readonly exported: unknown; readonly nonJson: string | undefined }
  | { readonly _tag: "FormatsUnloadable"; readonly reason: string };

// The loaders' evaluation: synchronous, its memo the process's. An evaluation is kept only when the module still
// holds the text read before it, so a save that lasts past the evaluation is not memoized under the earlier text. An
// edit undone before the re-read still can be (the child imports the module itself, as 963d3e4's did): this narrows
// that race, it does not close it.
function evaluateFormats(path: string): Evaluated {
  const content = readContent(path);

  if (content._tag === "FormatsUnloadable") {
    return content;
  }

  const hit = EVALUATED.get(path);

  if (hit?.content === content.text) {
    return hit.result;
  }

  const result = evaluateModule(path);
  const after = readContent(path);

  if (after._tag === "Content" && after.text === content.text) {
    EVALUATED.set(path, { content: content.text, result });
  }

  return result;
}

function readContent(
  path: string
):
  | { readonly _tag: "Content"; readonly text: string }
  | { readonly _tag: "FormatsUnloadable"; readonly reason: string } {
  try {
    return { _tag: "Content", text: readFileSync(path, "utf8") };
  } catch (error) {
    return { _tag: "FormatsUnloadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Evaluate a formats module in a fresh Node, with `spawnSync`, for the loaders and `ProjectFormats` alike. A fresh Node
 * because Node's module cache, which require and import share, never evicts an ES module, so an in-process load would
 * keep the first content for the life of a dev server.
 *
 * `spawnSync`, not effect/process's `ChildProcessSpawner`, on purpose: its semantics are the CLI's contract, and the
 * Effect spawner does not reproduce them. It caps the combined output at 1 MiB with its `ENOBUFS` reason, keeps the
 * child in the CLI's process group (Ctrl-C reaches it), gives it stdin at EOF, keeps stderr when a signal ends the
 * child, and decodes stdout keeping a byte order mark (so a module that prints one is "writes to stdout").
 *
 * @param path - The module's absolute path.
 * @returns What evaluating it gave.
 */
export function evaluateModule(path: string): Evaluated {
  const child = spawnSync(
    process.execPath,
    evaluationArgs(path),
    // The host's NODE_OPTIONS (an inspector port, a loader) belong to the host, not to this evaluation.
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
  );

  return child.error === undefined
    ? parseEvaluation(child.status, child.stdout, child.stderr)
    : { _tag: "FormatsUnloadable", reason: child.error.message };
}

/**
 * Read what the evaluating Node printed.
 *
 * @param status - Its exit code; null when a signal ended it.
 * @param stdout - What it printed on stdout.
 * @param stderr - What it printed on stderr.
 * @returns The evaluation.
 */
export function parseEvaluation(status: number | null, stdout: string, stderr: string): Evaluated {
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
