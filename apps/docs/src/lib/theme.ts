import type { ColorSchemeOptions, ThemeInput } from "@elmeragroup/fuse/theme";

/** The theme every document carries: Fuse's neutral identity, the look of a developer's tool. */
export const DOCUMENT_THEME = {
  identity: "neutral",
  brand: "elma",
  segment: "private",
} as const satisfies ThemeInput;

/** The visitor's light, dark or system appearance, kept in the browser under a key of the site's own. */
export const DOCUMENT_COLOR_SCHEME = {
  storageKey: "intl-docs-color-scheme",
  defaultColorScheme: "system",
  enableSystem: true,
} as const satisfies ColorSchemeOptions;
