import type { ReactNode } from "react";

import { IntlProvider } from "@elmeragroup/intl/react";
import { getIntl } from "@elmeragroup/intl/server";

import "../../intl/configure";

// The react-server provider hands the client the request locale's catalog.
export default async function MainLayout({ children }: { readonly children: ReactNode }) {
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
