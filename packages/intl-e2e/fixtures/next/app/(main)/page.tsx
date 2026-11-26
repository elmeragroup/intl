import { Plural, Select, T } from "@elmeragroup/intl/react";
import { getIntl } from "@elmeragroup/intl/server";

import { ActionButton } from "../../components/action-button";
import { ActionLocaleSwitcher } from "../../components/action-locale-switcher";
import { ClientBox } from "../../components/client-box";
import { CorpusList } from "../../components/corpus-list";
import { receiverForms } from "../../components/forms/receiver-forms";
import { LocaleSwitcher } from "../../components/locale-switcher";
import { DESCRIPTOR, DUE } from "../../components/messages";

export const dynamic = "force-dynamic";

// A non-`other` branch and a `one` form, so the server <T> resolving neither would show.
const PAYER = "company";
const PARCELS = 1;

export default async function Page() {
  const intl = await getIntl();

  return (
    <main>
      <p id="rsc-element">
        <T>Server element</T>
      </p>
      {/* A select and a plural through the react-server build of `/react`, which only a server component gets. */}
      <p id="rsc-select">
        <T>
          Billed to the <Select payer={PAYER} _company="company" _private="household" other="customer" />
        </T>
      </p>
      <p id="rsc-plural">
        <T>
          The server holds <Plural count={PARCELS} one="# parcel" other="# parcels" />
        </T>
      </p>
      <p id="rsc-call">{intl.t("Hello from the server")}</p>
      <p id="rsc-date">{intl.t("Due {d, date, short}", { d: DUE })}</p>
      {/* The receiver call forms, extracted and translated. */}
      <p id="rsc-forms">{(await receiverForms()).join(" ")}</p>
      <ClientBox descriptor={DESCRIPTOR} />
      <ActionButton />
      <LocaleSwitcher />
      <p id="rsc-action-switch">{intl.t("Rendered with the action's locale")}</p>
      <ActionLocaleSwitcher />
      <CorpusList />
    </main>
  );
}
