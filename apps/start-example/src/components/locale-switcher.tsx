import { useRef, useState } from "react";

import { useHydrated } from "@tanstack/react-router";

import { T, useIntl, useT } from "@elmeragroup/intl/react";
import type { SwitchOutcome } from "@elmeragroup/intl/start";
import { useLocaleSwitch } from "@elmeragroup/intl/start";

import { setLocale } from "../intl/intl.functions";
import { LANGUAGES } from "../intl/locale";

/**
 * Switches the language in place: the server function stores the choice, then the loaders re-run, so the provider's
 * catalog and the loader data change together and client state (the cart) survives.
 */
export function LocaleSwitcher() {
  const intl = useIntl();
  const t = useT();
  const hydrated = useHydrated();
  const { switchLocale, isPending } = useLocaleSwitch((locale) => setLocale({ data: locale }));

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
