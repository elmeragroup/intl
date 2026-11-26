// Where a project's catalogs live: each locale's PO path, and the locale a PO path is the catalog of. A leaf, so a
// catalog import (catalog-import.ts, which Next's po-loader and Vite's `load` share) resolves its catalog without
// loading the extractor.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
  // As written first, with no system call: the common case of every import. A host hands over the file at its real
  // path (Turbopack's loader, Vite's resolved id), so the catalogs the config names through a link match on a miss.
  const written = config.locales.find((locale) => resolve(catalogPath(config, locale)) === resolve(file));

  if (written !== undefined) {
    return written;
  }

  // Only a file one locale's catalog resolves to: a file several link to names none of them.
  const real = realPath(resolve(file));
  const matched = config.locales.filter((locale) => realPath(resolve(catalogPath(config, locale))) === real);

  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * A path resolved through the links of its nearest existing ancestor, as a bundler resolves it: what follows that
 * ancestor (a `{locale}` pattern, a file not written yet) stays as written.
 *
 * @param path - The path, absolute.
 * @returns The real path.
 */
export function realPath(path: string): string {
  let ancestor = path;
  let rest = "";

  for (;;) {
    const parent = dirname(ancestor);
    let resolved: string | undefined;
    try {
      resolved = realpathSync.native(ancestor);
    } catch {
      resolved = undefined;
    }

    if (resolved !== undefined || parent === ancestor) {
      const base = resolved ?? ancestor;

      return rest === "" ? base : join(base, rest);
    }

    rest = rest === "" ? basename(ancestor) : join(basename(ancestor), rest);
    ancestor = parent;
  }
}
