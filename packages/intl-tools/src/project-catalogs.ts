// Where a project's catalogs live: each locale's PO path, and the locale a PO path is the catalog of. A leaf, so a
// catalog import (catalog-import.ts, which Next's po-loader and Vite's `load` share) resolves its catalog without
// loading the extractor.
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ProjectConfig } from "./project-config";
import { identityPathSync, realPathSync } from "./real-path";

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
 * Every configured locale whose catalog resolves to a PO file: what a loader compiles an imported `.po` for when it is
 * one, and refuses naming them when it is several (a file their catalogs share through a link), or as no catalog when
 * it is none.
 *
 * @param config - The project config.
 * @param file - An absolute path.
 * @returns The locales, in the config's order.
 */
export function catalogLocales(config: ProjectConfig, file: string): ReadonlyArray<string> {
  // Each locale is matched, also when one locale's catalog names the file as written (`locales/sv -> nb`: compiled for
  // `nb`, `sv`'s import would get `nb`'s plural rules and formats). So each import resolves the file and every locale's
  // catalog, one real-path lookup each, with no as-written shortcut: an as-written match says nothing of the other
  // locales' links (#98). A host hands over the file at its real path (Turbopack's loader, Vite's resolved id), so
  // catalogs the config names through a link match too. Each catalog's path is resolved as `extract` writes it, never
  // collapsed: a `..` in an absolute pattern climbs where the kernel takes it, and one after a directory that does not
  // exist names no file (`extract` refuses it as `CatalogClimbsMissing`), while the imported file exists. Whether the
  // file is a catalog is a question of identity, so both sides take the kernel's answer (`identityPathSync`).
  const real = fileIdentity(file);

  return config.locales.filter((locale) => catalogIdentity(catalogPath(config, locale)) === real);
}

/**
 * A file's identity: its real path as the kernel resolves it (`identityPathSync`), through its nearest existing
 * ancestor, so a file just deleted, or not written yet, still has one. Two paths name one file when their identities
 * are equal.
 *
 * @param file - The file, relative paths from the working directory.
 * @returns The identity.
 */
export function fileIdentity(file: string): string {
  const { base, rest } = nearestReal(resolve(file), identityPathSync);

  return join(base, ...rest);
}

/**
 * A catalog path's identity, as `fileIdentity`, resolved as `extract` writes it, never collapsed; none when a `..`
 * follows its nearest existing ancestor: the kernel climbs out of no missing directory, so joining that `..` onto the
 * ancestor would name a file the path never reaches.
 *
 * @param path - The catalog's path, absolute, as `catalogPath` spells it.
 * @returns The identity, or undefined when the path reaches no file.
 */
export function catalogIdentity(path: string): string | undefined {
  const { base, rest } = nearestReal(path, identityPathSync);

  return rest.includes("..") ? undefined : join(base, ...rest);
}

/**
 * A path resolved through the links of its nearest existing ancestor, as a bundler resolves it: what follows that
 * ancestor (a `{locale}` pattern, a file not written yet) stays as written.
 *
 * @param path - The path, absolute.
 * @returns The real path.
 */
export function realPath(path: string): string {
  const { base, rest } = nearestReal(path, realPathSync);

  return join(base, ...rest);
}

// A path's nearest existing ancestor, at its real path as `resolveReal` reads it (the hosts' `realPathSync`, or the
// kernel's `identityPathSync` for a comparison), and the segments after it as written.
function nearestReal(path: string, resolveReal: (path: string) => string) {
  let ancestor = path;
  const rest: Array<string> = [];

  for (;;) {
    const parent = dirname(ancestor);
    let resolved: string | undefined;
    try {
      resolved = resolveReal(ancestor);
    } catch {
      resolved = undefined;
    }

    if (resolved !== undefined || parent === ancestor) {
      return { base: resolved ?? ancestor, rest };
    }

    rest.unshift(basename(ancestor));
    ancestor = parent;
  }
}
