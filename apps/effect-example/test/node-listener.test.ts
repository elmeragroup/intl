import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";

import { listen } from "../src/node-listener.ts";

// Resolves once a new connection to `origin` is refused: the listener has stopped accepting. Tries again on the event
// loop's next turn while one connects, not on a timer; the test's timeout is the hang guard.
function refusesConnections(origin: string): Promise<void> {
  const { hostname, port } = new URL(origin);

  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = connect(Number(port), hostname);

      socket.once("connect", () => {
        socket.destroy();
        setImmediate(attempt);
      });
      socket.once("error", () => {
        resolve();
      });
    };

    attempt();
  });
}

// Unit under test: listen's release, the server's graceful shutdown when its scope closes (SIGINT or SIGTERM in
// main.ts). Oracle: the shutdown contract written in node-listener.ts: closing the scope stops accepting connections,
// lets a response in flight finish before its connection closes, and only then settles.
describe("closing the server's scope", () => {
  it("stops listening and lets a response in flight finish", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const scope = await Effect.runPromise(Scope.make());
    const origin = await Effect.runPromise(
      listen(
        async () => {
          entered.resolve();
          await release.promise;

          return new Response("The whole body, after shutdown began.");
        },
        { port: 0, host: "127.0.0.1" }
      ).pipe(Scope.provide(scope))
    );

    expect(origin).toBeDefined();
    const url = origin ?? "";
    const body = fetch(url).then((response) => response.text());

    await entered.promise;
    // Whether the held handler was released when the scope's close settled, or `undefined` while it is pending.
    let releasedAtClose: boolean | undefined;
    let released = false;
    const closed = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      releasedAtClose = released;
    });

    await refusesConnections(url);
    // The listener has stopped accepting, but the response in flight holds the close open.
    expect(releasedAtClose).toBeUndefined();
    released = true;
    release.resolve();

    expect(await body).toBe("The whole body, after shutdown began.");
    await closed;
    expect(releasedAtClose).toBe(true);
  });
});
