// The entry point, run as written by Node (`node src/main.ts`): reads the port, then serves the API over its own
// catalogs until SIGINT or SIGTERM.
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { Catalogs } from "./intl/catalogs.ts";
import { serverLayer } from "./server.ts";

// The example's port when PORT is unset: the host examples' dev servers hold 3030 and 3031. `PORT=0` takes a free one,
// as the HTTP tests do; the log line names it.
const DEFAULT_PORT = 3032;

// A TCP port, or 0 for a free one. `Config.Port` starts at 1, which leaves the tests no way to ask for a free port.
const ListenPort = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }));

const main = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.schema(ListenPort, "PORT").pipe(Config.withDefault(DEFAULT_PORT));

    // The catalogs first: the server requires them, so a catalog that does not compile fails the start before it
    // listens.
    return serverLayer({ port, host: "127.0.0.1" }).pipe(Layer.provide(Catalogs.layer));
  })
);

Layer.launch(main).pipe(NodeRuntime.runMain);
