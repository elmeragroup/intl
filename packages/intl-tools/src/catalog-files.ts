// The commands' file-system edges: where a catalog is read and written, and the failure of any I/O the commands do not
// classify. Still Node's synchronous fs underneath, behind a port the commands reach through the context, so the
// effectful edges, not the commands, change when they move to `FileSystem`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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

/** Where catalogs are read and written. */
export type CatalogStorage = {
  /** A catalog's text; undefined when it does not exist. */
  readonly read: (path: string) => Effect.Effect<string | undefined, ProjectIoFailed>;
  /** Writes a catalog's text, making its directory. */
  readonly write: (path: string, text: string) => Effect.Effect<void, ProjectIoFailed>;
};

/**
 * The catalogs on Node's file system. A reference with that default, so a host provides nothing to run a command,
 * and a test can stand between a sync's read and its writes.
 */
export const CatalogFiles = /* @__PURE__ */ Context.Reference<CatalogStorage>(
  "elmera-intl-tools/CatalogFiles",
  {
    defaultValue: () => ({
      read: (path) => ioEdge("read", () => (existsSync(path) ? readFileSync(path, "utf8") : undefined)),
      write: (path, text) =>
        ioEdge("write", () => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
        }),
    }),
  }
);
