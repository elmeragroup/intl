// A button that asks the server for text, and the answer it got: translated by the API route or by a server function.
import { useState } from "react";
import type { ReactNode } from "react";

import { useHydrated } from "@tanstack/react-router";

import { Button } from "@elmeragroup/fuse/button";
import { T } from "@elmeragroup/intl/react";

/** What one request has shown: nothing yet, the server's text, or that it did not answer. */
export type Answer =
  | { readonly _tag: "Unasked" }
  | { readonly _tag: "Answered"; readonly text: string }
  | { readonly _tag: "Failed" };

/** No answer to show: not asked yet, or asked and turned back before reaching the server. */
export const UNASKED: Answer = { _tag: "Unasked" };

/** The request never got an answer. */
export const FAILED: Answer = { _tag: "Failed" };

/**
 * The server's text, as an answer.
 *
 * @param text - What the server said.
 * @returns The answer that shows it.
 */
export function answered(text: string): Answer {
  return { _tag: "Answered", text };
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
 * One button and the answer it asked for. The button stays disabled while its request is in flight, so one answer is
 * pending at a time and a slow, older reply can never overwrite a newer one. Pending is this request's own state, not a
 * transition: React entangles overlapping async transitions, even from separate hooks, so one stalled request would
 * hold every other button disabled and its answer back. Key it by the locale, so a switch clears an answer given in
 * the old language, and a reply still in flight lands on the unmounted instance.
 *
 * @param props - The answer's element id, the request (which never rejects: every failure is an answer), whether the
 *   button submits its form, and the button's label.
 */
export function AnswerRequest({
  id,
  ask,
  submit = "no",
  children,
}: {
  readonly id: string;
  readonly ask: () => Promise<Answer>;
  readonly submit?: "yes" | "no";
  readonly children: ReactNode;
}) {
  const hydrated = useHydrated();
  const [answer, setAnswer] = useState(UNASKED);
  const [pending, setPending] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type={submit === "yes" ? "submit" : "button"}
        variant={submit === "yes" ? "default" : "outline"}
        disabled={!hydrated || pending}
        onClick={() => {
          setPending(true);
          void ask()
            .then(setAnswer)
            .finally(() => {
              setPending(false);
            });
        }}>
        {children}
      </Button>
      <output id={id} className="text-sm text-muted-foreground">
        <AnswerText answer={answer} />
      </output>
    </div>
  );
}
