"use client";
import { useRef, useState } from "react";

import type { SwitchOutcome } from "@elmeragroup/intl/next";
import { useLocaleSwitch } from "@elmeragroup/intl/next";
import { T, useIntl, useT } from "@elmeragroup/intl/react";

import { setLocale } from "../app/actions";
import { LANGUAGES } from "../intl/locale";
import { useHydrated } from "./use-hydrated";

/**
 * Switches the language in place: the server action stores the choice and Next re-renders the page in its response,
 * so the server text and the provider's catalog change together and client state (the cart) survives.
 */
export function LocaleSwitcher() {
  const intl = useIntl();
  const t = useT();
  const hydrated = useHydrated();
  const { switchLocale, isPending } = useLocaleSwitch(setLocale, { refresh: "server-action" });

  // How the latest switch ended, so a failed one says so. Only the latest attempt speaks: an older one can still fail
  // (`PersistFailed`) after a newer one started, and that failure is no longer the visitor's choice
  // (#22: the hook should report it as `Superseded`).
  const [outcome, setOutcome] = useState<SwitchOutcome | undefined>(undefined);
  const latestAttempt = useRef(0);

  return (
    <nav aria-label={t("Language")} aria-busy={isPending}>
      {LANGUAGES.map(({ locale, name }) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-pressed={intl.locale === locale}
          disabled={!hydrated}
          onClick={() => {
            latestAttempt.current += 1;
            const attempt = latestAttempt.current;
            setOutcome(undefined);
            void switchLocale(locale).then((ended) => {
              if (attempt === latestAttempt.current) {
                setOutcome(ended);
              }
            });
          }}>
          {name}
        </button>
      ))}
      <p id="locale-status" role="status">
        {outcome === undefined ? null : <SwitchStatus outcome={outcome} />}
      </p>
    </nav>
  );
}

// What a visitor needs to know about how their switch ended: nothing when it worked, why it did not otherwise.
function SwitchStatus({ outcome }: { readonly outcome: SwitchOutcome }) {
  switch (outcome._tag) {
    case "Switched":
    case "Superseded":
      return null;
    case "PersistFailed":
      return <T>Your language choice was not saved. Try again.</T>;
    case "RefreshFailed":
      return <T>Your language choice was saved. Reload the page to see it.</T>;
  }
}
