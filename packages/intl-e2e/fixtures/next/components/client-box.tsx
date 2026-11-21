"use client";
import { useEffect } from "react";

import type { Descriptor } from "@elmeragroup/intl/core";
import { T, useIntl } from "@elmeragroup/intl/react";

import { DUE } from "./messages";

// The descriptor comes from the server page, over the wire.
export function ClientBox({ descriptor }: { readonly descriptor: Descriptor }) {
  const intl = useIntl();

  // The specs wait for it before clicking: a click before hydration does nothing (a dev server hydrates late).
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <section>
      <p id="client-call">{intl.t("Hello from a call")}</p>
      <p id="client-element">
        <T>Hello from an element</T>
      </p>
      <p id="client-from">{intl.t.from(descriptor)}</p>
      <p id="client-date">{intl.t("Due {d, date, short}", { d: DUE })}</p>
    </section>
  );
}
