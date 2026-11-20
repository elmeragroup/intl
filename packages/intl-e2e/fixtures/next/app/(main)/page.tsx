import { T } from "@elmeragroup/intl/react";
import { getIntl } from "@elmeragroup/intl/server";

import { ActionButton } from "../../components/action-button";
import { ClientBox } from "../../components/client-box";
import { CorpusList } from "../../components/corpus-list";
import { receiverForms } from "../../components/forms/receiver-forms";
import { LocaleSwitcher } from "../../components/locale-switcher";
import { DESCRIPTOR, DUE } from "../../components/messages";

export const dynamic = "force-dynamic";

export default async function Page() {
  const intl = await getIntl();

  return (
    <main>
      <p id="rsc-element">
        <T>Server element</T>
      </p>
      <p id="rsc-call">{intl.t("Hello from the server")}</p>
      <p id="rsc-date">{intl.t("Due {d, date, short}", { d: DUE })}</p>
      {/* The receiver call forms, extracted and translated. */}
      <p id="rsc-forms">{(await receiverForms()).join(" ")}</p>
      <ClientBox descriptor={DESCRIPTOR} />
      <ActionButton />
      <LocaleSwitcher />
      <CorpusList />
    </main>
  );
}
