import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { expect } from "vitest";

import { projectServices } from "../src/project-services";
import { CatalogSync } from "../src/watch";
import { it, projectConfig } from "./watch-project";

// Unit under test: `CatalogSync.layer()`, built inside a span, as a host builds its runtime. Oracle: the contract by
// hand: a sync's spans belong to the sync, so the extract's own span parents under `CatalogSync.extract`, never under
// the span the layer was built in. A tracer records each span and its parent.
it("parents a sync's spans under its extract, not under the layer's build", async ({ project }) => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);

      return span;
    },
  });

  await Effect.runPromise(
    CatalogSync.use((sync) =>
      sync.extract(projectConfig(project), { unused: "keep", concurrentSave: "yield" })
    ).pipe(
      Effect.provide(CatalogSync.layer().pipe(Layer.provide(projectServices()))),
      Effect.withSpan("host builds its runtime"),
      Effect.provideService(Tracer.Tracer, tracer)
    )
  );
  const parentOf = (name: string) =>
    spans
      .filter((span) => span.name === name)
      .map((span) =>
        Option.match(span.parent, {
          onNone: () => "none",
          onSome: (parent) => ("name" in parent ? parent.name : "external"),
        })
      );

  expect(parentOf("elmera-intl.extractCatalogs")).toEqual(["CatalogSync.extract"]);
});
