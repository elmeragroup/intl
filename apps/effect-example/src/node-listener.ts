// The API on a Node port. srvx's Node adapter turns Node's request into a Fetch `Request` (its `signal` aborts when the
// client goes away) and writes the `Response` back; effect's `HttpEffect.toWebHandler` runs the app on that `Request`
// and interrupts the request's fiber on the abort. This module owns only the listener's lifetime, tied to the Effect
// scope.
//
// effect's own Node server lives in `@effect/platform-node`, which the workspace does not install (its required redis
// peer auto-installs 15 MB; pnpm-workspace.yaml), and `@effect/platform-node-shared` has no HTTP server.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Http from "node:http";
import type { Server } from "srvx";
import { serve } from "srvx/node";

/** The server could not listen: the port is taken, or the host cannot be bound. */
export class ServerListenFailed extends Schema.TaggedError<ServerListenFailed>()("ServerListenFailed", {
  /** The port it tried. */
  port: Schema.Int,
  /** Node's error, as emitted. */
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not listen on port ${String(this.port)}`;
  }
}

/** Where the server listens. */
export type ListenOptions = {
  /** The TCP port; `0` takes a free one, which the log line names. */
  readonly port: number;
  /** The interface to bind. */
  readonly host: string;
};

/** A Fetch handler: a `Request` in, its `Response` out. */
export type FetchHandler = (request: Request) => Promise<Response>;

// How long shutdown waits for the responses in flight before it closes their connections.
const SHUTDOWN_DEADLINE_MS = 10_000;

// How often shutdown closes the connections that went idle since it began: a keep-alive connection whose response
// finished after `close()` would otherwise stay open until Node's keep-alive timeout, and hold the close up.
const IDLE_SWEEP_MS = 50;

// Stops listening and waits for the responses in flight to finish, closing each connection once it is idle. At the
// deadline, every connection still open is closed, a response still running with it, and the close settles.
async function closeGracefully(server: Server): Promise<void> {
  const listener = server.node?.server instanceof Http.Server ? server.node.server : undefined;
  const sweep = setInterval(() => {
    listener?.closeIdleConnections();
  }, IDLE_SWEEP_MS);
  const deadline = setTimeout(() => {
    listener?.closeAllConnections();
  }, SHUTDOWN_DEADLINE_MS);

  try {
    await server.close();
  } finally {
    clearInterval(sweep);
    clearTimeout(deadline);
  }
}

/**
 * Serve `handler` on `options` while the scope is open, and log the address once it listens
 * (`Listening on http://…`). Closing the scope stops accepting connections and lets the responses in flight finish,
 * closing their connections only after a deadline.
 *
 * @param handler - The app as a Fetch handler.
 * @param options - The port and interface to listen on.
 * @returns The origin the server listens on, or `ServerListenFailed`.
 */
export const listen = Effect.fn("listen")(function* (handler: FetchHandler, options: ListenOptions) {
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      // `manual`: listen here, where a failure is a typed error; srvx's own signal handlers and log line are off,
      // since the Effect runtime owns shutdown and logging.
      try: async () => {
        const created = serve({
          fetch: handler,
          port: options.port,
          hostname: options.host,
          manual: true,
          silent: true,
          gracefulShutdown: false,
        });

        // Node's adapter listens in `serve()`, which settles once it listens, or with its error.
        await created.serve();
        return created;
      },
      catch: (cause) => new ServerListenFailed({ port: options.port, cause }),
    }),
    (listening) => Effect.promise(() => closeGracefully(listening))
  );
  const origin = server.url === undefined ? undefined : new URL(server.url).origin;

  yield* Effect.logInfo(`Listening on ${origin ?? "an unknown address"}`);

  return origin;
});
