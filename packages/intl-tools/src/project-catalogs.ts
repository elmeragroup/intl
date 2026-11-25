// Where a project's catalogs live: each locale's PO path, and the locale a PO path is the catalog of. A leaf, so a
// catalog import (catalog-import.ts, which Next's po-loader and Vite's `load` share) resolves its catalog without
// loading the extractor.
import { isAbsolute, join, resolve } from "node:path";

import type { ProjectConfig } from "./project-config";

/**
 * Path of a locale's PO file.
 *
 * @param config - The project config.
 * @param locale - The locale.
 * @returns The absolute path.
 */
export function catalogPath(config: ProjectConfig, locale: string): string {
  const pattern = config.catalogs.replaceAll("{locale}", locale);

  return isAbsolute(pattern) ? pattern : join(config.root, pattern);
}

/**
 * The configured locale a PO file is the catalog of: what a loader compiles an imported `.po` for.
 *
 * @param config - The project config.
 * @param file - An absolute path.
 * @returns The locale, or undefined when the file is not one of the configured locales' catalogs.
 */
export function catalogLocale(config: ProjectConfig, file: string): string | undefined {
  return config.locales.find((locale) => resolve(catalogPath(config, locale)) === resolve(file));
}
