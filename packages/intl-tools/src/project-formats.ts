// The app's `formats` module, loaded as the runtime gets it. A leaf, so a catalog import (catalog-import.ts, which
// Next's po-loader and Vite's `load` share) compiles with the app's formats without loading the extractor or Effect.
// Its evaluation, retry and memo (`loadSnapshot`) are shared with `ProjectFormats` (project-formats-service.ts), which
// reads the module through `FileSystem` for the hosts' Effect runtimes; each owns only its read and how it runs.
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
  const module = config.formats;

  if (module === undefined) {
    return { _tag: "Formats", formats: undefined };
  }

  for (let attempt = 1; ; attempt += 1) {
    const content = readContent(module);

    if (content._tag === "FormatsUnloadable") {
      return unreadableFormats(config.root, module, content.reason);
    }

    const step = loadSnapshot(LOADED, config.root, module, content.text, attempt);

    if (step._tag !== "ReadAgain") {
      return step;
    }
  }
}

/**
 * The problem with a formats module that cannot be read.
 *
 * @param root - The project root, which the problem names the module from.
 * @param module - The module's absolute path.
 * @param reason - Why the read failed, as Node's synchronous read words it.
 * @returns The `FormatsInvalid` problem.
 */
export function unreadableFormats(root: string, module: string, reason: string): FormatsLoaded {
  return judgeFormats(root, module, { _tag: "FormatsUnloadable", reason });
}

/** One load's outcome for a text read of the module: the formats or their problem, or a reason to read it again. */
export type FormatsStep = FormatsLoaded | { readonly _tag: "ReadAgain" };

/**
 * Load the formats from one read of the module, the one policy of both memos: a memo hit for exactly that text, or an
 * evaluation of it (`evaluateModule`), kept only when it gave valid formats. Anything else runs again on the next load:
 * a cause outside the module's text (a module it imports, not there yet or not valid yet) may be gone by then, and a
 * module being fixed costs one evaluation per load. A refusal (the module changed while Node loaded it) asks the caller
 * to read the module again, ATTEMPTS times in total, and is then reported.
 *
 * @param memo - The caller's memo.
 * @param root - The project root, which a problem names the module from.
 * @param module - The module's absolute path.
 * @param text - The module's text, as the caller read it.
 * @param attempt - Which read of this load it is, from 1.
 * @returns The formats or their problem, or `ReadAgain`.
 */
export function loadSnapshot(
  memo: FormatsMemo,
  root: string,
  module: string,
  text: string,
  attempt: number
): FormatsStep {
  const hit = memo.get(module);

  if (hit?.content === text) {
    return { _tag: "Formats", formats: hit.formats };
  }

  const evaluated = evaluateModule(module, text);

  if (evaluated._tag === "FormatsChanged" && attempt < ATTEMPTS) {
    return { _tag: "ReadAgain" };
  }

  const judged = judgeFormats(root, module, evaluated);

  if (judged._tag === "Formats" && judged.formats !== undefined) {
    memo.set(module, { content: text, formats: judged.formats });
  }

  return judged;
}

// An evaluation of the config's formats module, judged: the formats, or the `FormatsInvalid` problem with them.
function judgeFormats(root: string, module: string, loaded: Evaluated): FormatsLoaded {
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

  if (loaded._tag === "FormatsChanged") {
    const last = loaded.diagnostic === undefined ? "" : `; the last load failed with ${loaded.diagnostic}`;

    return invalid(`cannot load: ${CHANGED}, on all ${ATTEMPTS} attempts in total${last}`);
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

// Why the evaluating Node refuses an evaluation: the entry's bytes as Node loaded them are not the text the parent read.
const CHANGED = "the formats module changed while Node loaded it";
// The refusal's signal, both parts required: this exit code (EX_TEMPFAIL) and, on stdout, which a refusing child
// writes nothing else to (it refuses before the module runs), the payload `{ "elmeraIntlRefused": CHANGED }` with the
// failed load's own error, if any, as `diagnostic`. Stderr stays the module's and Node's. A module faking both (it
// prints the payload and exits 75) only costs retries and a report: a refusal is never memoized.
const REFUSED = 75;
// How many reads and evaluations one load makes of a module that keeps changing while Node loads it, in total.
const ATTEMPTS = 3;

// The comparison of the entry's bytes with the parent's text, preloaded with --import before the evaluation's script
// (PRINT_FORMATS, the base's script byte for byte, so its diagnostics name the same lines). The parent's text comes on
// stdin, read to EOF first (so the module sees stdin at EOF). Node resolves and loads the entry as it always does,
// deciding its format from the bytes it read, and the hooks compare those bytes with the parent's text: the
// evaluation runs only when they are one text, so it is exactly what the memo is keyed by, format included (#17).
// Every load of the entry is compared: a load of its resolved URL, or of what the requested path is a link to at that
// moment, which Node 24 and 25's CommonJS loader loads again after a symlink is swapped onto the path. A resolution or
// a load that throws (the file gone, a partial save Node cannot strip) is compared with the bytes read here instead:
// bytes that differ, or none, refuse; the same bytes rethrow Node's error. A load that never compared fails the
// evaluation. Residuals: the modules the entry imports are read from disk (the memo keys the entry's text only); both
// sides decode UTF-8, so bytes that are not UTF-8 compare as U+FFFD; and on Node 24 and 25 the path can be swapped to
// another module and back between the CommonJS loader's resolution and the hook's look at the path, a window of
// microseconds that only a swap to another valid formats module could use, which no security boundary sits behind
// (the app's own files).
const COMPARE_ON_LOAD = `
import { readFileSync, realpathSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const requested = process.argv[1];
const snapshot = readFileSync(0, "utf8");
const refuse = (error) => {
  const diagnostic = error === undefined ? undefined : String(error).split("\\n")[0];
  writeSync(1, JSON.stringify({ elmeraIntlRefused: "${CHANGED}", diagnostic }));
  process.exit(${REFUSED});
};
const textOf = (source) => typeof source === "string" ? source : source == null ? undefined : Buffer.from(source).toString("utf8");
const readOf = (url) => { try { return readFileSync(fileURLToPath(url), "utf8"); } catch { return undefined; } };
const linkedTo = () => { try { return pathToFileURL(realpathSync(fileURLToPath(requested))).href; } catch { return undefined; } };
const unless = (url, error) => {
  if (readOf(url) !== snapshot) refuse(error);
  throw error;
};
let entry;
let compared = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== requested || entry !== undefined) return nextResolve(specifier, context);
    let resolved;
    try {
      resolved = nextResolve(specifier, context);
    } catch (error) {
      unless(requested, error);
    }
    entry = resolved.url;
    return resolved;
  },
  load(url, context, nextLoad) {
    if (entry === undefined || (url !== entry && url !== linkedTo())) return nextLoad(url, context);
    let loaded;
    try {
      loaded = nextLoad(url, context);
    } catch (error) {
      unless(url, error);
    }
    if (textOf(loaded.source) !== snapshot) refuse(undefined);
    compared = true;
    return loaded;
  },
});
process.on("exit", (code) => {
  if (code === 0 && !compared) {
    writeSync(2, "Error: the formats module was not loaded through the comparison with the text read\\n");
    process.exitCode = 1;
  }
});
`;

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

/** The valid formats of each module path, with the text they were evaluated from: never a problem or a failure. */
export type FormatsMemo = Map<string, { readonly content: string; readonly formats: Formats }>;

// The loaders' memo: per process, keyed by the content, so an edit evaluates again and an unchanged module that
// evaluated costs one read.
const LOADED: FormatsMemo = new Map();

// What evaluating a formats module gave: its export and the first value JSON would not carry, why it failed, or a
// refusal (the module changed between its read and Node's load; retried, then reported, never memoized), with the
// load's own error when the load threw.
type Evaluated =
  | { readonly _tag: "Evaluated"; readonly exported: unknown; readonly nonJson: string | undefined }
  | { readonly _tag: "FormatsUnloadable"; readonly reason: string }
  | { readonly _tag: "FormatsChanged"; readonly diagnostic: string | undefined };

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

/*
 * Evaluate a formats module's text in a fresh Node, with `spawnSync`, for the loaders and `ProjectFormats` alike. A fresh Node
 * because Node's module cache, which require and import share, never evicts an ES module, so an in-process load would
 * keep the first content for the life of a dev server.
 *
 * `spawnSync`, not effect/process's `ChildProcessSpawner`, on purpose: its semantics are the CLI's contract, and the
 * Effect spawner does not reproduce them. It caps the combined output at 1 MiB with its `ENOBUFS` reason, keeps the
 * child in the CLI's process group (Ctrl-C reaches it), keeps stderr when a signal ends the child, and decodes stdout
 * keeping a byte order mark (so a module that prints one is "writes to stdout"). The text goes to the child on stdin,
 * which the child reads to EOF before the module loads, so stdout still carries the result alone and the module still
 * sees stdin at EOF; the child evaluates the module only when Node's bytes of it are that text.
 *
 * It takes the module's absolute path, which Node resolves and decides the format by, and the module's text as the
 * caller read it, and gives what evaluating that text gave, or `FormatsChanged` when Node loaded other bytes.
 */
function evaluateModule(path: string, content: string): Evaluated {
  const child = spawnSync(
    process.execPath,
    [
      `--import=data:text/javascript,${encodeURIComponent(COMPARE_ON_LOAD)}`,
      "--input-type=module",
      "--eval",
      PRINT_FORMATS,
      pathToFileURL(path).href,
    ],
    // The host's NODE_OPTIONS (an inspector port, a loader) belong to the host, not to this evaluation.
    { encoding: "utf8", input: content, env: { ...process.env, NODE_OPTIONS: "" } }
  );

  return child.error === undefined
    ? parseEvaluation(child.status, child.stdout, child.stderr)
    : { _tag: "FormatsUnloadable", reason: child.error.message };
}

// A refusal's payload on stdout, or undefined when stdout carries none.
function refusalOf(stdout: string): Evaluated | undefined {
  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const fields =
    typeof printed === "object" && printed !== null
      ? new Map<string, unknown>(Object.entries(printed))
      : undefined;
  const diagnostic = fields?.get("diagnostic");

  return fields?.get("elmeraIntlRefused") === CHANGED
    ? { _tag: "FormatsChanged", diagnostic: typeof diagnostic === "string" ? diagnostic : undefined }
    : undefined;
}

/**
 * Read what the evaluating Node printed.
 *
 * @param status - Its exit code; null when a signal ended it.
 * @param stdout - What it printed on stdout.
 * @param stderr - What it printed on stderr.
 * @returns The evaluation.
 */
function parseEvaluation(status: number | null, stdout: string, stderr: string): Evaluated {
  if (status !== 0) {
    const refusal = status === REFUSED ? refusalOf(stdout) : undefined;

    if (refusal !== undefined) {
      return refusal;
    }

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
