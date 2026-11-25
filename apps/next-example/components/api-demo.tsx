"use client";
import { useState } from "react";
import type { ReactNode } from "react";

import { T, useIntl } from "@elmeragroup/intl/react";

import { confirmOrder } from "../app/actions";
import { useHydrated } from "./use-hydrated";

// What one request has shown: nothing yet, the server's text, or that it did not answer.
type Answer =
  | { readonly _tag: "Unasked" }
  | { readonly _tag: "Answered"; readonly text: string }
  | { readonly _tag: "Failed" };

const UNASKED: Answer = { _tag: "Unasked" };
const FAILED: Answer = { _tag: "Failed" };

function answered(text: string): Answer {
  return { _tag: "Answered", text };
}

// A non-2xx status is a failure, whatever its body says; so is a request that never got a response.
async function fetchGreeting(): Promise<Answer> {
  try {
    const response = await fetch("/api/greeting");

    return response.ok ? answered(await response.text()) : FAILED;
  } catch {
    return FAILED;
  }
}

function AnswerText({ answer }: { readonly answer: Answer }): ReactNode {
  switch (answer._tag) {
    case "Unasked":
      return null;
    case "Answered":
      return answer.text;
    case "Failed":
      return <T>The server did not answer. Try again.</T>;
  }
}

/**
 * Text translated on the server on request: by the API route, and by a server action. Keyed by the locale, so a switch
 * clears answers given in the old language, and a reply still in flight lands on the unmounted instance.
 */
export function ApiDemo() {
  return <Answers key={useIntl().locale} />;
}

function Answers() {
  return (
    <section aria-labelledby="api-heading">
      <h2 id="api-heading">
        <T>Server answers</T>
      </h2>
      <AnswerRequest id="api-greeting" ask={fetchGreeting}>
        <T>Call the API</T>
      </AnswerRequest>
      <AnswerRequest id="action-confirmation" ask={askConfirmation}>
        <T>Confirm the order</T>
      </AnswerRequest>
    </section>
  );
}

function askConfirmation(): Promise<Answer> {
  return confirmOrder().then(answered, () => FAILED);
}

// One button and the answer it asked for. The button stays disabled while its request is in flight, so one answer is
// pending at a time and a slow, older reply can never overwrite a newer one. Pending is this request's own state, not a
// transition: React entangles overlapping async transitions, even from separate hooks, so one stalled request would
// hold every other button disabled and its answer back.
function AnswerRequest({
  id,
  ask,
  children,
}: {
  readonly id: string;
  readonly ask: () => Promise<Answer>;
  readonly children: ReactNode;
}) {
  const hydrated = useHydrated();
  const [answer, setAnswer] = useState(UNASKED);
  const [pending, setPending] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={!hydrated || pending}
        onClick={() => {
          setPending(true);
          // `ask` never rejects: every failure is an answer.
          void ask()
            .then(setAnswer)
            .finally(() => {
              setPending(false);
            });
        }}>
        {children}
      </button>
      <output id={id}>
        <AnswerText answer={answer} />
      </output>
    </>
  );
}
