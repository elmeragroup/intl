"use client";
import { useState } from "react";

import { useLocaleSwitch } from "@elmeragroup/intl/next";

import type { ActionSwitchTexts } from "../app/actions";
import { switchLocaleInAction } from "../app/actions";

// Persists through a server action, whose response carries the re-rendered page, so the switch skips the refresh. The
// action returns what it read, which persist shows; an action returning text is not a `persist` itself.
export function ActionLocaleSwitcher() {
  const [texts, setTexts] = useState<ActionSwitchTexts | undefined>(undefined);
  const { switchLocale, isPending } = useLocaleSwitch(
    async (locale) => {
      setTexts(await switchLocaleInAction(locale));
    },
    { refresh: "server-action" }
  );

  return (
    <section>
      <button id="action-switch-en" type="button" onClick={() => void switchLocale("en")}>
        en
      </button>
      <p id="action-switch-state">{isPending ? "pending" : "idle"}</p>
      <p id="action-switch-before">{texts?.before}</p>
      <p id="action-switch-after">{texts?.after}</p>
    </section>
  );
}
