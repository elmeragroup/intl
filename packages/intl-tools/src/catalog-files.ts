// The commands' file-system edges: where a catalog is read and written, how a project's text is read through
// `FileSystem`, and the failure of any I/O the commands do not classify. Every read goes through `FileSystem`, which
// each host provides at its edge; the one exception is a catalog's guarded write (see `CatalogFiles.layer`).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * I/O the commands do not classify threw, such as a file a checkout deletes mid-scan or a directory where a catalog
 * goes. The one-shot hosts take it as the crash it was (`elmera-intl failed: ` and its stack); a watch reports it as a
 * `SyncFailed` and retries on the next change.
 */
export class ProjectIoFailed
  extends /* @__PURE__ */ Schema.TaggedError<ProjectIoFailed>()("ProjectIoFailed", {
    /** What the commands were doing. */
    operation: /* @__PURE__ */ Schema.Literals(["scan", "formats", "read", "write"]),
    /** What was thrown, as thrown. */
    cause: /* @__PURE__ */ Schema.Defect(),
  }) {}

/**
 * What a `ProjectIoFailed` says: the thrown Error's message, or the thrown value.
 *
 * @param failure - The failure.
 * @returns Its reason, as one line of a problem.
 */
export function ioFailureReason(failure: ProjectIoFailed): string {
  return failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
}

/**
 * Run a synchronous edge, its throw a `ProjectIoFailed`.
 *
 * @template A - What the edge returns.
 * @param operation - What the edge does.
 * @param run - The edge.
 * @returns An effect that runs it.
 */
export function ioEdge<A>(
  operation: ProjectIoFailed["operation"],
  run: () => A
): Effect.Effect<A, ProjectIoFailed> {
  return Effect.try({ try: run, catch: (cause) => new ProjectIoFailed({ operation, cause }) });
}

/**
 * A `PlatformError` as the commands' failure: its cause is the error Node raised, as a synchronous read threw it, so
 * every message and crash line built from it reads as before.
 *
 * @param operation - What the commands were doing.
 * @returns The failure for one `PlatformError`.
 */
export function platformFailed(
  operation: ProjectIoFailed["operation"]
): (error: PlatformError.PlatformError) => ProjectIoFailed {
  return (error) => new ProjectIoFailed({ operation, cause: error.reason.cause ?? error });
}

/**
 * A file's text as `readFileSync(path, "utf8")` decodes it, a byte order mark kept: the guarded write compares against
 * that decoding, and `withIntl` parses the config with it. (`FileSystem.readFileString`'s TextDecoder drops the mark.)
 *
 * @param files - The file system.
 * @param path - The file.
 * @returns Its text.
 */
export const readText = (
  files: FileSystem.FileSystem,
  path: string
): Effect.Effect<string, PlatformError.PlatformError> =>
  files
    .readFile(path)
    .pipe(
      Effect.map((bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"))
    );

/**
 * A file's text, or undefined when Node's `existsSync` says it does not exist: any failure to reach it (a self-looping
 * link, a file where a directory goes) reads as absent, so it surfaces where the file is next used, as before.
 *
 * @param files - The file system.
 * @param path - The file.
 * @returns Its text; undefined when it is unreachable.
 */
export const readTextIfExists = /* @__PURE__ */ Effect.fnUntraced(function* (
  files: FileSystem.FileSystem,
  path: string
) {
  const exists = yield* files.exists(path).pipe(Effect.orElseSucceed(() => false));

  return exists ? yield* readText(files, path) : undefined;
});

/** How a catalog write treats the text it replaces. */
export type WriteGuard =
  /** Write over whatever the catalog holds (`extract`). */
  | { readonly _tag: "Overwrite" }
  /**
   * Write only while the catalog holds one of `texts` (undefined: absent): its own snapshot, or a text this sync wrote
   * (to it or to another path naming the same file), so a save since is never written over.
   */
  | { readonly _tag: "IfHoldsOneOf"; readonly texts: ReadonlySet<string | undefined> };

/** What a guarded catalog write did. */
export type WriteOutcome =
  /** The catalog now holds the text. */
  | "written"
  /** The catalog already held the text, so it was not written: its mtime stays. */
  | "unchanged"
  /** The catalog no longer holds what the guard expected, so nothing was written. */
  | "changed";

/**
 * The synchronous file operations a guarded write runs as one call, so its read, comparison and write never yield in
 * between.
 */
export type CatalogFileSystem = {
  /** A file's text; undefined when it does not exist. */
  readonly read: (path: string) => string | undefined;
  /** Writes a file's text, making its directory. */
  readonly write: (path: string, text: string) => void;
};

/** Node's synchronous file system, as `CatalogFiles.layer()` writes with it. */
export const NODE_CATALOG_FILES: CatalogFileSystem = {
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};

/** Where catalogs are read and written. */
export class CatalogFiles
  extends /* @__PURE__ */ Context.Service<
    CatalogFiles,
    {
      /** A catalog's text; undefined when it does not exist. */
      readonly read: (path: string) => Effect.Effect<string | undefined, ProjectIoFailed>;
      /** A catalog's text; a catalog that does not exist fails as its read did. */
      readonly readExisting: (path: string) => Effect.Effect<string, ProjectIoFailed>;
      /**
       * Write a catalog's text, making its directory, unless it already holds the text or (under `IfHoldsOneOf`)
       * holds none of the texts the guard allows. One operation: its read, its comparison and its write never yield to
       * another fiber in between, so a save made from this process meanwhile is either seen or lands after the write.
       */
      readonly write: (
        path: string,
        text: string,
        guard: WriteGuard
      ) => Effect.Effect<WriteOutcome, ProjectIoFailed>;
    }
  >()("elmera-intl-tools/CatalogFiles")
{
  /**
   * The catalogs read through `FileSystem`, and written by one synchronous call of `fs`.
   *
   * The write stays synchronous on purpose. A watch's translator may save a catalog from this process (an editor
   * plugin, a test) while a sync runs: with an asynchronous re-read and write, another fiber runs in between and its
   * save is written over, the lost save layer 5 closed. A lock would exclude only writers that take it, never a save
   * made around it, so one synchronous call is the only in-process atomicity there is (`watch-saves.test.ts`, "yields
   * inside a guarded write").
   *
   * @param fs - The guarded write's operations; Node's unless a test runs something between them.
   * @returns A layer reading through the host's `FileSystem` and writing through `fs`.
   */
  static layer(
    fs: CatalogFileSystem = NODE_CATALOG_FILES
  ): Layer.Layer<CatalogFiles, never, FileSystem.FileSystem> {
    return Layer.effect(
      CatalogFiles,
      FileSystem.FileSystem.useSync((files) => ({
        read: Effect.fn("CatalogFiles.read")(function* (path: string) {
          return yield* readTextIfExists(files, path).pipe(Effect.mapError(platformFailed("read")));
        }),
        readExisting: Effect.fn("CatalogFiles.readExisting")(function* (path: string) {
          return yield* readText(files, path).pipe(Effect.mapError(platformFailed("read")));
        }),
        // The read, the comparison and the write are one synchronous call: nothing can run between them.
        write: Effect.fn("CatalogFiles.write")(function* (path: string, text: string, guard: WriteGuard) {
          return yield* ioEdge("write", (): WriteOutcome => {
            const current = fs.read(path);

            if (guard._tag === "IfHoldsOneOf" && !guard.texts.has(current)) {
              return "changed";
            }

            if (current === text) {
              return "unchanged";
            }

            fs.write(path, text);

            return "written";
          });
        }),
      }))
    );
  }
}
