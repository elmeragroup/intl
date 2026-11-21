// `*.po` imports, as `withIntl` (Next) and `intl()` (Vite) compile them. Reference it once from the app:
// `/// <reference types="@elmeragroup/intl-tools/po" />`.
declare module "*.po" {
  import type { Catalog } from "@elmeragroup/intl/core";

  /** The compiled catalog of the locale the PO file is for. */
  const catalog: Catalog;
  export default catalog;
}

declare module "*.po?source" {
  import type { Catalog } from "@elmeragroup/intl/core";

  /** The compiled English catalog: the PO's msgids. */
  const catalog: Catalog;
  export default catalog;
}
