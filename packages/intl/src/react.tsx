"use client";
// Client build of `/react`: the translator comes from <IntlProvider>. `react-server.tsx` has the same export list.
// `createIntl`, `useIntl` and `IntlProvider` share react-intl's and use-intl's names on purpose: they match the install
// name, and an app imports ours from this distinct specifier, so the two never meet in one import.
import type { ReactNode } from "react";
import { createContext, use, useMemo } from "react";

import type { Format, IntlConfig, IntlInstance, Translate } from "./intl";
import { createIntl } from "./intl";
import { useLatestRef } from "./latest-ref";
import { renderT } from "./resolve";

export { Plural, Select, Val, type PluralProps, type SelectProps, type ValProps } from "./resolve";
export { createIntl, msg } from "./intl";

const IntlContext = /* @__PURE__ */ createContext<IntlInstance | null>(null);

/** Props of `<IntlProvider>`: a serializable `IntlConfig`, so a server layout or a route loader can pass it. */
export type IntlProviderProps = IntlConfig & {
  /**
   * `createIntl`'s `onError`: a message that fails to format or is not extracted yet, or a failed `format` call. A new
   * function each render does not re-create the translator; a changed handler takes effect from the next commit.
   */
  readonly onError?: (error: Error, key: string) => void;
  readonly children: ReactNode;
};

/**
 * Provide the translator for a subtree. A new `locale`, `catalog`, `timeZone` or `formats` re-creates it in the same
 * render, so a locale switch lands in one commit with whatever server data arrived alongside it.
 *
 * @param props - Locale, catalog, time zone, named styles and children.
 * @returns The provider.
 */
export function IntlProvider({
  locale,
  catalog,
  timeZone,
  formats,
  onError,
  children,
}: IntlProviderProps): ReactNode {
  const latestOnError = useLatestRef(onError);
  const intl = useMemo(
    () =>
      createIntl({
        locale,
        catalog,
        timeZone,
        formats,
        onError: (error, key) => {
          latestOnError.current?.(error, key);
        },
      }),
    [locale, catalog, timeZone, formats, latestOnError]
  );

  return <IntlContext value={intl}>{children}</IntlContext>;
}

/**
 * The current translator, for code that needs the locale or passes an `IntlInstance` on (`intl.t("literal")` is extracted).
 *
 * @returns The provided `IntlInstance`.
 * @throws Outside `<IntlProvider>`: a setup defect.
 */
export function useIntl(): IntlInstance {
  const intl = use(IntlContext);

  if (!intl) {
    throw new Error("<T>, useT and useIntl need an <IntlProvider> above them");
  }

  return intl;
}

/** Props of `<T>`. */
export type TProps = {
  /** Text, elements, fragments, `<Val>`, `<Plural>` and `<Select>`; no `{expressions}`. */
  readonly children: ReactNode;
  /** A literal context that disambiguates equal sources. */
  readonly context?: string;
};

/**
 * Translate JSX in place: `<T>Hello <Val name={n} />, read the <a href="/t">terms</a>.</T>`.
 *
 * @param props - The message as children and an optional literal context.
 * @returns The translated content.
 */
export function T({ children, context }: TProps): ReactNode {
  return renderT(useIntl(), children, context);
}

/**
 * The current `t`, for client components, sync server components and directive-less shared components.
 *
 * @returns The translate function; bind it where it is called (`const t = useT()`).
 */
export function useT(): Translate {
  return useIntl().t;
}

/**
 * The current formatter, next-intl's `useFormatter()`: dates and times in the provider's zone, named formats from its
 * `formats`.
 *
 * @returns The provided instance's `format`.
 */
export function useFormat(): Format {
  return useIntl().format;
}
