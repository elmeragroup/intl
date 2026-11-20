import { useState } from "react";

import { T } from "@elmeragroup/intl/react";
import { useLocaleSwitch } from "@elmeragroup/intl/start";

// The cookie is what getIntlConfig's resolveLocale reads; the switch then re-runs the root loader in place.
export function LocaleSwitcher() {
  const [text, setText] = useState("");
  const { switchLocale, isPending } = useLocaleSwitch((locale) => {
    document.cookie = `locale=${locale}; path=/`;
  });

  return (
    <section>
      <input id="typed" value={text} onChange={(event) => setText(event.target.value)} />
      <button id="switch-en" type="button" onClick={() => void switchLocale("en")}>
        en
      </button>
      <button id="switch-nb" type="button" onClick={() => void switchLocale("nb")}>
        nb
      </button>
      <p id="switch-state">{isPending ? "pending" : "idle"}</p>
      <p id="switch-label">
        <T>Language</T>
      </p>
    </section>
  );
}
