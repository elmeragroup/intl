// react-server build of `/react`: same export list as `react.tsx`, with the translator read from the request.
import type { ReactNode } from "react";
import { use } from "react";

import type { IntlProviderProps, TProps } from "@elmeragroup/intl/internal/react-client";
// The provider through the client module's own specifier: it stays external in the build, so a server layout
// rendering <IntlProvider> gets a client reference instead of server code calling createContext.
import { IntlProvider as ClientIntlProvider } from "@elmeragroup/intl/internal/react-client";

import type { Format, IntlInstance, Translate } from "./intl";
import { renderT } from "./resolve";
import { getIntl } from "./server";

export { Plural, Select, Val, type PluralProps, type SelectProps, type ValProps } from "./resolve";
export { createIntl, msg } from "./intl";
export type { IntlProviderProps, TProps } from "@elmeragroup/intl/internal/react-client";

/**
 * Provide the translator to client components (see the client `IntlProvider`).
 *
 * @param props - Locale, catalog, time zone, named styles and children.
 * @returns The client provider.
 */
export function IntlProvider(props: IntlProviderProps): ReactNode {
  return <ClientIntlProvider {...props} />;
}

/**
 * Translate JSX in a server component (see the client `T`).
 *
 * @param props - The message as children and an optional literal context.
 * @returns The translated content.
 */
export async function T({ children, context }: TProps): Promise<ReactNode> {
  return renderT(await getIntl(), children, context);
}

/**
 * The request's translator in a sync server or shared component.
 *
 * @returns The request's `IntlInstance`.
 */
export function useIntl(): IntlInstance {
  return use(getIntl());
}

/**
 * The request's `t` in a sync server or shared component. Async server components use `await getT()` from
 * `/server`, since hooks cannot run after an await.
 *
 * @returns The translate function.
 */
export function useT(): Translate {
  return useIntl().t;
}

/**
 * The request's formatter in a sync server or shared component (see the client `useFormat`). Async server components
 * use `await getFormat()` from `/server`.
 *
 * @returns The request's `format`.
 */
export function useFormat(): Format {
  return useIntl().format;
}
