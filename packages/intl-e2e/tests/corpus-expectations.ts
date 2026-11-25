// The corpus' hand-written renders (fixtures/next/components/corpus.tsx and fixtures/start/src/components/corpus.tsx,
// in their order): English as the original corpus writes it, and Norwegian from the fixtures' catalogs (no in Next, nb
// in Start, same translations). As React's server renderer escapes them, which is what a server-rendered item holds.
export const CORPUS: ReadonlyArray<{ readonly en: string; readonly translated: string }> = [
  { en: "Don&#x27;t lose your cart", translated: "Ikke mist handlekurven" },
  { en: "Literal {} braces", translated: "Bokstavelige {} klammer" },
  { en: "Two &#x27;&#x27; apostrophes", translated: "To &#x27;&#x27; apostrofer" },
  { en: "Copyright © Elmera — 2026…", translated: "Opphavsrett © Elmera — 2026…" },
  { en: "Delete &#x27;Ada&#x27;?", translated: "Slett &#x27;Ada&#x27;?" },
  { en: "Tab here", translated: "Tabulator her" },
  { en: "Multi line with spaces", translated: "Flere linjer med mellomrom" },
  {
    en: 'Read <a href="/a">this</a> and <a href="/b">that</a>',
    translated: 'Les <a href="/a">dette</a> og <a href="/b">det</a>',
  },
  { en: "Hi <b>dear Ada</b>!", translated: "Hei <b>kjære Ada</b>!" },
  { en: "Wrapped fragment here", translated: "Innpakket fragment her" },
  { en: "You have 2 orders", translated: "Du har 2 ordrer" },
  { en: "Open", translated: "Åpne" },
  { en: "Line one<br/>line two", translated: "Linje en<br/>linje to" },
  { en: "Price &lt; 100 #1", translated: "Pris &lt; 100 #1" },
  { en: "The <b>players&#x27;</b> cards", translated: "<b>Spillernes</b> kort" },
  { en: "100 kr", translated: "100 kroner" },
  { en: "Item &#x27;#1&#x27; or a&#x27;|b", translated: "Vare &#x27;#1&#x27; eller a&#x27;|b" },
  {
    en: "Got 2 users&#x27; &lt;b&gt;{x}&lt;/b&gt;",
    translated: "Fikk 2 brukeres &lt;b&gt;{x}&lt;/b&gt;",
  },
  {
    en: "There are orders sold for this person <b>in the last month</b>.",
    translated: "Det er solgt ordrer for denne personen <b>i løpet av den siste måneden</b>.",
  },
  { en: "Pick #1", translated: "Velg #1" },
  { en: "Pick A", translated: "Velg A" },
];
