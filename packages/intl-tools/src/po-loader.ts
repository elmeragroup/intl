// The Turbopack (webpack-loader API) loader `withIntl` registers on `*.po`: compile the imported catalog
// (catalog-import.ts), mapped onto the loader context.
import type { CatalogImport } from "./catalog-import";
import { compileCatalogImport } from "./catalog-import";
import type { PoLoaderOptions } from "./next";

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

// Calls the callback exactly once: with the module, or with the failure the import reports (a CatalogCompileError as
// it is, with every problem in its message). A throw (a defect) is passed on as loader-runner passes a synchronous
// throw after `this.async()`, as an Error even when the thrown value is not one, so a `throw null` cannot read as
// success. The compile is synchronous: a loader worker has no Effect runtime, so it reads the config and the formats
// module with Node's sync fs and keeps the formats memo for the worker's life (project-formats.ts).
async function run(
  context: LoaderContext,
  po: string,
  callback: (error: Error | null, code?: string) => void
): Promise<void> {
  let outcome: CatalogImport["outcome"];
  try {
    outcome = await Promise.try(compile, context, po);
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  if (outcome._tag === "Failed") {
    callback(outcome.error);
  } else {
    callback(null, outcome.code);
  }
}

// The import's outcome, every dependency it reports registered first, failed or not.
function compile(context: LoaderContext, po: string): CatalogImport["outcome"] {
  const { config, source } = context.getOptions();
  const { dependencies, outcome } = compileCatalogImport({
    config,
    file: context.resourcePath,
    readPo: () => po,
    source,
  });

  for (const dependency of dependencies) {
    context.addDependency(dependency);
  }

  return outcome;
}
