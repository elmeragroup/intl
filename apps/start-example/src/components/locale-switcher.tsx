import { createContext, use, useState } from "react";
import type { ReactNode } from "react";

import { useHydrated } from "@tanstack/react-router";

import { Button } from "@elmeragroup/fuse/button";
import { T, useIntl, useT } from "@elmeragroup/intl/react";
import type { LocaleSwitch, SwitchOutcome } from "@elmeragroup/intl/start";
import { useLocaleSwitch } from "@elmeragroup/intl/start";

import { setLocale } from "../intl/intl.functions";
import { LANGUAGES } from "../intl/locale";

const LocaleSwitchContext = createContext<LocaleSwitch | undefined>(undefined);

/**
 * Holds the app's one locale switch, for the switcher on Settings. `useLocaleSwitch` keeps its switches in one queue,
 * where the latest wins; a switcher that called it itself would start a second queue each time Settings mounted again,
 * and a switch still held in the old queue could then land after a newer one and take the page back to its language.
 * The shell mounts this once, outside the page, so every switch the visitor makes joins the same queue.
 *
 * @param props - The shell's content.
 */
export function LocaleSwitchProvider({ children }: { readonly children: ReactNode }) {
  const localeSwitch = useLocaleSwitch((locale) => setLocale({ data: locale }));

  return <LocaleSwitchContext value={localeSwitch}>{children}</LocaleSwitchContext>;
}

function useAppLocaleSwitch(): LocaleSwitch {
  const localeSwitch = use(LocaleSwitchContext);
  if (localeSwitch === undefined) {
    throw new Error("LocaleSwitcher needs a LocaleSwitchProvider above it: the shell mounts one.");
  }

  return localeSwitch;
}

/**
 * Switches the language in place through the shell's switch: the server function stores the choice, then the loaders
 * re-run, so the provider's catalog, the shell around the page and the loaders' text change together, and client state
 * (the settings draft beside it) survives.
 */
export function LocaleSwitcher() {
  const intl = useIntl();
  const t = useT();
  const hydrated = useHydrated();
  const { switchLocale, isPending } = useAppLocaleSwitch();

  // How the latest switch ended, so a failed one says so. A switch a newer one replaced resolves `Superseded`, which
  // shows nothing, and every switch starts from a click, so every outcome can be shown as it arrives.
  const [outcome, setOutcome] = useState<SwitchOutcome | undefined>(undefined);

  return (
    <nav aria-label={t("Language")} aria-busy={isPending} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {LANGUAGES.map(({ locale, name }) => (
          <Button
            key={locale}
            type="button"
            size="sm"
            variant={intl.locale === locale ? "default" : "outline"}
            lang={locale}
            aria-pressed={intl.locale === locale}
            disabled={!hydrated}
            onClick={() => {
              setOutcome(undefined);
              void switchLocale(locale).then(setOutcome);
            }}>
            {name}
          </Button>
        ))}
      </div>
      <p id="locale-status" role="status" className="text-sm text-muted-foreground">
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
