import { IntlProvider } from "@elmeragroup/intl/react";
import { getIntl } from "@elmeragroup/intl/server";

import { IntlOnly } from "../../../components/intl-only";
import "../../../intl/configure";

export const dynamic = "force-dynamic";

export default async function Page() {
  const intl = await getIntl();

  return (
    <IntlProvider locale={intl.locale} catalog={intl.catalog} timeZone={intl.timeZone} formats={intl.formats}>
      <IntlOnly />
    </IntlProvider>
  );
}
