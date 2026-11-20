"use client";
import { useState } from "react";

import { runAction } from "../app/actions";

export function ActionButton() {
  const [result, setResult] = useState("");

  return (
    <section>
      <button
        id="action"
        type="button"
        onClick={() => {
          void runAction().then(setResult);
        }}>
        run
      </button>
      <p id="action-result">{result}</p>
    </section>
  );
}
