// The composition root: the API's routes over its handlers and the intl middleware's implementation, served on a Node
// port over the catalogs its caller provides. main.ts launches it over the app's own; the HTTP tests start main.ts as a
// process.
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Http from "node:http";

import { Api } from "./api.ts";
import { PortalHandlers } from "./handlers.ts";
import type { Catalogs } from "./intl/catalogs.ts";
import * as IntlMiddleware from "./intl/intl-middleware.ts";
import type { ListenOptions, ServerListenFailed } from "./node-listener.ts";
import { listen } from "./node-listener.ts";

/** The API's routes, over its handlers and the intl middleware; they read the catalogs from `Catalogs`. */
export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PortalHandlers),
  Layer.provide(IntlMiddleware.layer)
);

// The router's configuration. A path parameter may be as long as the request head Node accepts (`maxHeaderSize`, which
// `--max-http-header-size` sets), not find-my-way's default 100 characters, past which the router answers a bare 404
// before any middleware: an overlong invoice number reaches the endpoint's schema, and gets the same 400, in the
// request's language, as any other malformed one. Duplicate slashes collapse, the router's default, so `//greeting` is
// `/greeting`.
const ROUTER_CONFIG = { maxParamLength: Http.maxHeaderSize };

/**
 * The server: the routes built, then the port opened. It requires the catalogs, so a caller provides them first
 * (`Layer.provide(Catalogs.layer)`), and a catalog that does not compile fails the start before the server listens.
 * Closing the layer's scope stops listening, lets the responses in flight finish, then releases the routes.
 *
 * @param options - The port and interface to listen on.
 * @returns A layer that serves the API while it is in scope, over the `Catalogs` it requires.
 */
export function serverLayer(options: ListenOptions): Layer.Layer<never, ServerListenFailed, Catalogs> {
  const serve = Layer.effectDiscard(
    Effect.gen(function* () {
      const app = yield* HttpRouter.toHttpEffect(ApiRoutes).pipe(
        Effect.provideService(HttpRouter.RouterConfig, ROUTER_CONFIG)
      );
      const context = yield* Effect.context();
      // Each request's line in the log, as effect's own `HttpRouter.serve` logs it.
      const handler = HttpEffect.toWebHandler(app, HttpMiddleware.logger);

      yield* listen((request) => handler(request, context), options);
    })
  );

  // The services effect's responses may use (file bodies, ETags), which this API's JSON never needs.
  return serve.pipe(Layer.provide(HttpServer.layerServices));
}
