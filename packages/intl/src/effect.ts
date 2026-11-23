// `@elmeragroup/intl/effect`: the translator as an Effect service, for servers and jobs written with Effect. The only
// runtime module that imports `effect`, an optional peer (elmera-workspace/import-boundaries). Resolving the options is
// the app's effect; `createIntl` builds the translator, as on every host.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CreateIntlOptions, IntlInstance } from "./intl";
import { createIntl } from "./intl";

/**
 * The translator for the current request or job: `const { t } = yield* CurrentIntl`. The value is `createIntl(options)`
 * itself, so `t` keeps its literal typing and the extractor traces it. A catalog of another version throws in
 * `createIntl`, so it is a defect, as on every host; the options effect's own failures are its `E`.
 */
export class CurrentIntl
  extends /* @__PURE__ */ Context.Service<CurrentIntl, IntlInstance>()("elmera-intl/CurrentIntl")
{
  /**
   * A fixed translator shared by everything the layer is provided to: a single-locale worker, a CLI, tests.
   *
   * @param options - Locale, compiled catalog, time zone, named styles and an optional error callback.
   * @returns A layer that builds the translator once, when it is built.
   */
  static layer(options: CreateIntlOptions): Layer.Layer<CurrentIntl> {
    return Layer.sync(CurrentIntl, () => createIntl(options));
  }

  /**
   * Per request or job: the options resolve each time the wrapped effect runs, so no translator outlives its run.
   * Never a layer: `Effect.provide` reuses a layer an enclosing runtime already built.
   *
   * @template E - The options effect's failure, such as a catalog that cannot load.
   * @template R - The options effect's requirements, such as the HTTP request.
   * @param options - Resolves the request's locale, compiled catalog and time zone.
   * @returns A function that provides `CurrentIntl` to an effect and adds the options effect's `E` and `R` to it.
   */
  static provide<E, R>(
    options: Effect.Effect<CreateIntlOptions, E, R>
  ): <A, E2, R2>(self: Effect.Effect<A, E2, R2>) => Effect.Effect<A, E | E2, Exclude<R2, CurrentIntl> | R> {
    return Effect.provideServiceEffect(
      CurrentIntl,
      options.pipe(Effect.map((resolved) => createIntl(resolved)))
    );
  }
}
