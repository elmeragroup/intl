import type { ReactNode } from "react";

import { IntlProvider } from "@elmeragroup/intl/react";
import { getIntl } from "@elmeragroup/intl/server";

import "../intl/configure";

/** The root layout: the request's locale, catalog, zone and formats reach the client components through the provider. */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const intl = await getIntl();

  return (
    <html lang={intl.locale}>
      <body>
        <IntlProvider
          locale={intl.locale}
          catalog={intl.catalog}
          timeZone={intl.timeZone}
          formats={intl.formats}>
          {children}
        </IntlProvider>
      </body>
    </html>
  );
}
