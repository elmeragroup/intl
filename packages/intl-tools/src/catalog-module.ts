// The JS module a `*.po` import compiles to, for every loader.
import type { Catalog } from "@elmeragroup/intl/internal/catalog";

/**
 * The module text whose default export is the catalog.
 *
 * @param catalog - The compiled catalog.
 * @returns An ES module: `JSON.parse` of a string literal, which engines parse faster than the same object literal.
 */
export function catalogModule(catalog: Catalog): string {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(catalog))});\n`;
}
