// Fixtures for T, each with a hand-written key and render, so the oracle is independent of the serializer. The
// extractor reads this file too, so the runtime key and the extracted key face the same expectation.
import type { ReactNode } from "react";

import { Plural, Select, T, Val } from "@elmeragroup/intl/react";

function Link({ href, children }: { readonly href: string; readonly children?: ReactNode }) {
  return <a href={href}>{children}</a>;
}

const name = "Ada";
const count = 2;
const subject = "private";
const searchInterval = "lastMonth";
const kind = "1";
const accent = "e\u0301";

/** One `<T>` usage, its expected catalog key and its expected English render. */
export type Fixture = { readonly el: ReactNode; readonly key: string; readonly html: string };

// The whitespace fixtures (tab, multi-line, repeated spaces) must reach the compiler as written, so the formatter
// skips this list.
// oxfmt-ignore
export const fixtures: ReadonlyArray<Fixture> = [
  { el: <T>Don't lose your cart</T>, key: "Don't lose your cart", html: "Don&#x27;t lose your cart" },
  { el: <T>Literal {"{}"} braces</T>, key: "Literal '{}' braces", html: "Literal {} braces" },
  { el: <T>Two '' apostrophes</T>, key: "Two ''' apostrophes", html: "Two &#x27;&#x27; apostrophes" },
  { el: <T>Copyright &copy; Elmera &mdash; 2026&hellip;</T>, key: "Copyright © Elmera — 2026…", html: "Copyright © Elmera — 2026…" },
  { el: <T>Delete '<Val name={name} />'?</T>, key: "Delete ''{name}'?", html: "Delete &#x27;Ada&#x27;?" },
  { el: <T>Tab	here</T>, key: "Tab here", html: "Tab here" },
  { el: <T>
      Multi
      line   with   spaces
    </T>, key: "Multi line with spaces", html: "Multi line with spaces" },
  { el: <T>Read <a href="/a">this</a> and <Link href="/b">that</Link></T>, key: "Read <x0>this</x0> and <x1>that</x1>", html: 'Read <a href="/a">this</a> and <a href="/b">that</a>' },
  { el: <T>Hi <b>dear <Val name={name} /></b>!</T>, key: "Hi <x0>dear {name}</x0>!", html: "Hi <b>dear Ada</b>!" },
  { el: <T>Wrapped <>fragment</> here</T>, key: "Wrapped fragment here", html: "Wrapped fragment here" },
  { el: <T>You have <Plural count={count} _0="no orders" one="# order" other="# orders" /></T>, key: "You have {count, plural, =0 {no orders} one {# order} other {# orders}}", html: "You have 2 orders" },
  { el: <T context="verb">Open</T>, key: "verb\u0004Open", html: "Open" },
  { el: <T>Line one<br />line two</T>, key: "Line one<x0></x0>line two", html: "Line one<br/>line two" },
  { el: <T>Price {"<"} 100 {"#1"}</T>, key: "Price '<' 100 #1", html: "Price &lt; 100 #1" },
  { el: <T>The <b>players'</b> cards</T>, key: "The <x0>players''</x0> cards", html: "The <b>players&#x27;</b> cards" },
  { el: <T>100&nbsp;kr</T>, key: "100\u00a0kr", html: "100\u00a0kr" },
  { el: <T>Item '#1' or a'|b</T>, key: "Item ''#1' or a''|b", html: "Item &#x27;#1&#x27; or a&#x27;|b" },
  { el: <T>Got <Plural count={count} one="# user's {name}" other="# users' <b>{x}</b>" /></T>, key: "Got {count, plural, one {# user's '{'name'}'} other {# users' '<'b'>{'x'}<'/b'>'}}", html: "Got 2 users&#x27; &lt;b&gt;{x}&lt;/b&gt;" },
  // An adopting app's message shape: a select inside a tag. Branches keep their written order, `other` last.
  { el: <T>There are orders sold for this <Select subject={subject} _company="company" _private="person" other="customer" /> <b><Select searchInterval={searchInterval} _lastWeek="in the last week" _lastMonth="in the last month" _lastYear="in the last year" other="other" /></b>.</T>, key: "There are orders sold for this {subject, select, company {company} private {person} other {customer}} <x0>{searchInterval, select, lastWeek {in the last week} lastMonth {in the last month} lastYear {in the last year} other {other}}</x0>.", html: "There are orders sold for this person <b>in the last month</b>." },
  { el: <T>Pick <Select kind={kind} _2="it's {x}" _1="#1" other="none" /></T>, key: "Pick {kind, select, 2 {it's '{'x'}'} 1 {#1} other {none}}", html: "Pick #1" },
  // A decomposed `é` (e + U+0301) is a valid ICU key, kept unnormalized.
  { el: <T>Pick <Select accent={accent} _é="A" other="B" /></T>, key: "Pick {accent, select, e\u0301 {A} other {B}}", html: "Pick A" },
];
