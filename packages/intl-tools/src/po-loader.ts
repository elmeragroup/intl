// The Turbopack (webpack-loader API) loader `withIntl` registers on `*.po`: compile the imported catalog.
import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { catalogModule } from "./catalog-module";
import { describeProblem } from "./cli-run";
import { compileCatalog } from "./compile";
import type { PoLoaderOptions } from "./next";
import { catalogLocale, loadConfig, loadFormats } from "./project";

/** The part of Turbopack's webpack-loader context the loader uses. */
type LoaderContext = {
  readonly resourcePath: string;
  addDependency(file: string): void;
  getOptions(): PoLoaderOptions;
  async(): (error: Error | null, code?: string) => void;
};

/**
 * Compile one PO file to the module exporting its catalog, for the locale its path names (or English, with
 * `?source`), with the app's `formats`.
 *
 * @param po - The file's text.
 */
export default function poLoader(this: LoaderContext, po: string): void {
  const callback = this.async();
  const { config: configPath, source } = this.getOptions();
  const loaded = loadConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    callback(new Error(describeProblem(loaded.problem)));

    return;
  }

  const { config } = loaded;
  const locale = catalogLocale(config, this.resourcePath);

  if (locale === undefined) {
    callback(
      new Error(
        `elmera-intl: ${this.resourcePath} is not a configured catalog (${config.catalogs}, ${config.locales.join(", ")})`
      )
    );

    return;
  }

  // Before loading, so saving a repaired formats module reruns a load that failed on it.
  this.addDependency(configPath);

  if (config.formats !== undefined) {
    this.addDependency(config.formats);
  }

  const formats = loadFormats(config);

  if (formats._tag === "ConfigInvalid") {
    callback(new Error(describeProblem(formats.problem)));

    return;
  }

  const compiled = compileCatalog(po, source ? SOURCE_LOCALE : locale, { formats: formats.formats });

  if (compiled._tag === "CatalogCompileError") {
    callback(compiled);

    return;
  }

  callback(null, catalogModule(compiled.catalog));
}
