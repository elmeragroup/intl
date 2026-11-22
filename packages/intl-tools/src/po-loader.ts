// The Turbopack (webpack-loader API) loader `withIntl` registers on `*.po`: compile the imported catalog.
import { SOURCE_LOCALE } from "@elmeragroup/intl/internal/catalog";

import { catalogModule } from "./catalog-module";
import { compileCatalog } from "./compile";
import type { PoLoaderOptions } from "./next";
import { describeProblem } from "./problem";
import { catalogLocale, loadFormats } from "./project";
import { loadConfig } from "./project-config";

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
  void run(this, po, this.async());
}

// Calls the callback exactly once: with the module, or with the failure the import reports. A throw (a defect, or I/O
// this does not classify) is passed on as loader-runner passes a synchronous throw after `this.async()`, as an Error
// even when the thrown value is not one, so a `throw null` cannot read as success. A Promise, though the compile is
// still synchronous, so a later layer can run it as an Effect program.
async function run(
  context: LoaderContext,
  po: string,
  callback: (error: Error | null, code?: string) => void
): Promise<void> {
  let code: string;
  try {
    code = await Promise.try(compile, context, po);
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  callback(null, code);
}

// The catalog module's code; throws the error the import fails with.
function compile(context: LoaderContext, po: string): string {
  const { config: configPath, source } = context.getOptions();
  const loaded = loadConfig(configPath);

  if (loaded._tag === "ConfigInvalid") {
    throw new Error(describeProblem(loaded.problem));
  }

  const { config } = loaded;
  const locale = catalogLocale(config, context.resourcePath);

  if (locale === undefined) {
    throw new Error(
      `elmera-intl: ${context.resourcePath} is not a configured catalog (${config.catalogs}, ${config.locales.join(", ")})`
    );
  }

  // Before loading, so saving a repaired formats module reruns a load that failed on it.
  context.addDependency(configPath);

  if (config.formats !== undefined) {
    context.addDependency(config.formats);
  }

  const formats = loadFormats(config);

  if (formats._tag === "ConfigInvalid") {
    throw new Error(describeProblem(formats.problem));
  }

  const compiled = compileCatalog(po, source ? SOURCE_LOCALE : locale, { formats: formats.formats });

  if (compiled._tag === "CatalogCompileError") {
    // The CatalogCompileError itself, with every problem in its message.
    throw compiled;
  }

  return catalogModule(compiled.catalog);
}
