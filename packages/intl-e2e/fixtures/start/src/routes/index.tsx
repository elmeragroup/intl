import { useState } from "react";

import { createFileRoute } from "@tanstack/react-router";

import { T, useIntl } from "@elmeragroup/intl/react";

import { CorpusList } from "../components/corpus-list";
import { LocaleSwitcher } from "../components/locale-switcher";
import { ping } from "../intl.functions";
import { DESCRIPTOR, DUE } from "../messages";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const intl = useIntl();
  const [pong, setPong] = useState("");

  return (
    <main>
      <p id="call">{intl.t("Hello from a call")}</p>
      <p id="element">
        <T>Hello from an element</T>
      </p>
      <p id="from">{intl.t.from(DESCRIPTOR)}</p>
      <p id="date">{intl.t("Due {d, date, short}", { d: DUE })}</p>
      <button
        id="ping"
        type="button"
        onClick={() => {
          void ping().then(setPong);
        }}>
        ping
      </button>
      <p id="pong">{pong}</p>
      <LocaleSwitcher />
      <CorpusList />
    </main>
  );
}
