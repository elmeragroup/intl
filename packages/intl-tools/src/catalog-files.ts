// The commands' file-system edges: where a catalog is read and written, and the failure of any I/O the commands do not
// classify. Still Node's synchronous fs underneath, behind a service each host provides, so the effectful edges, not
// the commands, change when they move to `FileSystem`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
 * The synchronous file operations the live `CatalogFiles` runs, each of its operations one call of them, so a guarded
 * write's read, comparison and write never yield in between.
 */
export type CatalogFileSystem = {
  /** A file's text; undefined when it does not exist. */
  readonly read: (path: string) => string | undefined;
  /** A file's text; throws as Node's read when it does not exist. */
  readonly readExisting: (path: string) => string;
  /** Writes a file's text, making its directory. */
  readonly write: (path: string, text: string) => void;
};

/** Node's file system, as `CatalogFiles.layer()` reads and writes it. */
export const NODE_CATALOG_FILES: CatalogFileSystem = {
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  readExisting: (path) => readFileSync(path, "utf8"),
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
       * Write a catalog's text, making its directory, unless it already holds the text or (under `IfUnchangedFrom`)
       * changed. One operation: its read, its comparison and its write never yield to another fiber in between, so a
       * save made from this process meanwhile is either seen or lands after the write.
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
   * The catalogs on a synchronous file system, each operation one synchronous call.
   *
   * @param fs - The file operations; Node's unless a test runs something between them.
   * @returns A layer reading and writing through `fs`.
   */
  static layer(fs: CatalogFileSystem = NODE_CATALOG_FILES): Layer.Layer<CatalogFiles> {
    return Layer.succeed(CatalogFiles, {
      read: Effect.fn("CatalogFiles.read")(function* (path: string) {
        return yield* ioEdge("read", () => fs.read(path));
      }),
      readExisting: Effect.fn("CatalogFiles.readExisting")(function* (path: string) {
        return yield* ioEdge("read", () => fs.readExisting(path));
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
    });
  }
}
