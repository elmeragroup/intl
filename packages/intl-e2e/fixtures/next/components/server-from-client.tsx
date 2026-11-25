"use client";
import { Suspense, use, useEffect, useState } from "react";

import { getIntl } from "@elmeragroup/intl/server";

// What getIntl() settles to: "resolved", or the message it rejected with.
async function settle(): Promise<string> {
  try {
    await getIntl();

    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// One read per module instance, so the server render and hydration each read a promise that outlives the render:
// on the server, during the Client Component's SSR (the SSR layer, not react-server), and in the browser.
let rendered: Promise<string> | undefined;

function RenderOutcome() {
  rendered ??= settle();

  return <output id="server-from-client-render">{use(rendered)}</output>;
}

// A Client Component importing `/server`, which only server code may use: client and SSR code resolve its request
// config to the stub, so getIntl() rejects with the stub's message, both while the server renders this component and
// in the browser, and no client chunk holds the app's request module.
export function ServerFromClient() {
  const [outcome, setOutcome] = useState("idle");

  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  const call = async () => {
    setOutcome(await settle());
  };

  return (
    <>
      <Suspense>
        <RenderOutcome />
      </Suspense>
      <button id="server-from-client" type="button" aria-label="getIntl" onClick={() => void call()} />
      <output id="server-from-client-outcome">{outcome}</output>
    </>
  );
}
