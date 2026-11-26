// The Turbopack (webpack-loader API) loader `withIntl` registers on `*.po`: compile the imported catalog
// (catalog-import.ts), mapped onto the loader context.
import type { CatalogImport } from "./catalog-import";
import { compileCatalogImport } from "./catalog-import";
import type { PoLoaderOptions } from "./next";
import type { Problem } from "./problem";
import { describeProblem } from "./problem";
import type { TurbopackRoots } from "./turbopack-roots";
import { isInRoots } from "./turbopack-roots";

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

// The import's outcome, every dependency it reports inside Turbopack's roots registered first, failed or not. Turbopack
// fails an import on a dependency outside its roots with its own error, before the callback's, so the loader registers
// none and fails the import with the placement instead, whatever its own outcome.
function compile(context: LoaderContext, po: string): CatalogImport["outcome"] {
  const { config, source, roots } = context.getOptions();
  const { dependencies, outcome } = compileCatalogImport({
    config,
    file: context.resourcePath,
    readPo: () => po,
    source,
  });

  const outside: Array<string> = [];

  for (const dependency of dependencies) {
    if (roots === undefined || isInRoots(roots, dependency)) {
      context.addDependency(dependency);
    } else {
      outside.push(dependency);
    }
  }

  if (roots === undefined || outside.length === 0) {
    return outcome;
  }

  const problems = outside.map((file) =>
    describeProblem(placement(roots, file, file === config ? "the intl config" : "the formats module"))
  );

  return { _tag: "Failed", error: new Error(problems.join("\n")) };
}

// The problem with a dependency outside Turbopack's roots: the intl config, or the formats module it names.
function placement(
  roots: TurbopackRoots,
  file: string,
  what: "the intl config" | "the formats module"
): Problem {
  const additional =
    roots.additional.length === 0 ? "" : ` and its additional roots ${roots.additional.join(", ")}`;

  return {
    code: "OutsideTurbopackRoots",
    message: `${what} is outside the Turbopack root ${roots.root}${additional}, so Turbopack cannot load it as a dependency of this catalog import`,
    fix: `set ${roots.setting} to a directory that holds the app, the intl config, its formats module and its catalogs, or list a directory that holds the file, and neither holds nor lies in the Turbopack root, in experimental.turbopackAdditionalRoots`,
    file,
  };
}
