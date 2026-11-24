import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Catalogs } from "../src/intl/catalogs.ts";
import { serverLayer } from "../src/server.ts";

// Unit under test: the server's start (serverLayer with its catalogs provided, as main.ts launches it) over catalogs
// compiled from a fixture whose Swedish PO has a translation that does not parse, `Hej {name, välkommen tillbaka.`
// (test/fixtures/malformed-catalogs). Oracle: the startup contract written in server.ts and catalogs.ts, a catalog that
// does not compile fails the start with an error naming its locale and the compiler's report, before the port opens.
// The port is held by the test, so a start that tried to listen first would fail with ServerListenFailed instead.
const FIXTURE = new URL("fixtures/malformed-catalogs/", import.meta.url);

describe("a start over a catalog that does not compile", () => {
  const holder = createServer();
  let port = 0;

  beforeAll(async () => {
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    // SAFETY: a net.Server listening on a TCP port reports an AddressInfo, never a pipe name.
    port = (holder.address() as AddressInfo).port;
  });

  afterAll(async () => {
    holder.close();
    await once(holder, "close");
  });

  it("fails with the locale and the compiler's problem, before it listens", async () => {
    const failure = await Effect.runPromise(
      Layer.launch(
        serverLayer({ port, host: "127.0.0.1" }).pipe(Layer.provide(Catalogs.layerFrom(FIXTURE)))
      ).pipe(Effect.flip)
    );

    expect(failure._tag).toBe("CatalogLoadFailed");
    expect(failure).toMatchObject({ locale: "sv" });
    expect(failure.message).toContain("the sv catalog does not compile");
    expect(failure.message).toContain('"Hello {name}, welcome back."');
  });
});
