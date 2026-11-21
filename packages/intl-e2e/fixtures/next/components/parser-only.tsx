"use client";
import { useState } from "react";

import { IntlMessageFormat } from "intl-messageformat";

// intl-messageformat parses this string in the browser: the control that ships an ICU parser.
const COUNT = "{count, plural, one {# vare} other {# varer}}";

export function ParserOnly() {
  const [count, setCount] = useState(1);

  return (
    <button id="parser-only" type="button" onClick={() => setCount((value) => value + 1)}>
      {new IntlMessageFormat(COUNT, "no").format({ count })}
    </button>
  );
}
