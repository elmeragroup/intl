import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
// The API's compiled catalogs, one per locale, loaded once when the server starts. There is no bundler to compile a
// `*.po` import, so the PO files are read and compiled from disk by `loadCatalog`, the tools' loader for Node without
// one. A catalog that does not compile stops the start with the problems `elmera-intl check` would report: a request
// never meets a missing catalog.
import { fileURLToPath } from "node:url";

import { loadCatalog } from "@elmeragroup/intl-tools/compile";
import type { Catalog } from "@elmeragroup/intl/core";

import { formats } from "./formats.ts";
import type { Locale } from "./locale.ts";

/** A catalog that did not load: its PO is unreadable, or a message in it does not compile or format. */
export class CatalogLoadFailed extends Schema.TaggedError<CatalogLoadFailed>()("CatalogLoadFailed", {
  /** The locale whose catalog failed. */
  locale: Schema.String,
  /** The compiler's report: every problem, one per line. */
  report: Schema.String,
}) {
  override get message(): string {
    return this.report;
  }
}

// The PO each locale compiles from. English is the source, so its catalog is any PO's msgids, compiled for `en`.
const PO_FILES = {
  en: "nb.po",
  nb: "nb.po",
  sv: "sv.po",
  fi: "fi.po",
} as const satisfies Readonly<Record<Locale, string>>;

// One locale's catalog, compiled from its PO in `directory` with the API's formats.
const load = Effect.fnUntraced(function* (directory: URL, locale: Locale) {
  const path = fileURLToPath(new URL(PO_FILES[locale], directory));
  const compiled = loadCatalog(path, locale, { formats });

  if (compiled._tag === "CatalogCompileError") {
    return yield* new CatalogLoadFailed({ locale, report: compiled.message });
  }

  return compiled.catalog;
});

/** Every locale's compiled catalog, by locale. */
export class Catalogs extends Context.Service<Catalogs, Readonly<Record<Locale, Catalog>>>()(
  "effect-example/Catalogs"
) {
  /**
   * Reads and compiles the four catalogs in `directory` (`nb.po`, `sv.po`, `fi.po`) once, when the layer is built.
   *
   * @param directory - The directory that holds the POs, as a `file:` URL ending in `/`.
   * @returns A layer that provides the catalogs, or fails with the first locale's `CatalogLoadFailed`.
   */
  static layerFrom(directory: URL): Layer.Layer<Catalogs, CatalogLoadFailed> {
    return Layer.effect(
      Catalogs,
      Effect.gen(function* () {
        return {
          en: yield* load(directory, "en"),
          nb: yield* load(directory, "nb"),
          sv: yield* load(directory, "sv"),
          fi: yield* load(directory, "fi"),
        } satisfies Readonly<Record<Locale, Catalog>>;
      })
    );
  }

  /** The API's catalogs, beside this file, compiled once when the layer is built: at server start. */
  static readonly layer: Layer.Layer<Catalogs, CatalogLoadFailed> = Catalogs.layerFrom(
    new URL(".", import.meta.url)
  );
}
