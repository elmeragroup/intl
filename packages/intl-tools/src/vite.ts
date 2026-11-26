// Vite hosting: `import catalog from "./intl/nb.po"` compiles the catalog (`?source` for `en`), `vite dev` runs
// `extract --watch` in-process and reloads open tabs on a PO save, `vite build` runs `check` first.
import type { Plugin } from "vite";

import type { IntlPluginOptions } from "./vite-plugins";
import { intlPlugins } from "./vite-plugins";
import { hostServices } from "./watch";

export type { IntlPluginOptions } from "./vite-plugins";
export { intlCatalogs } from "./vite-plugins";

/**
 * The `@elmeragroup/intl` Vite plugin. A `*.po` import compiles to its catalog (`intlCatalogs`). Dev keeps the
 * catalogs in sync on save (add-only, problems printed to the terminal); build fails before bundling when
 * `elmera-intl check` finds a problem, with the CLI's output.
 *
 * @param options - Where the project config lives.
 * @returns The catalog, dev and build plugins.
 */
export function intl(options: IntlPluginOptions = {}): Array<Plugin> {
  return intlPlugins(options, hostServices());
}
