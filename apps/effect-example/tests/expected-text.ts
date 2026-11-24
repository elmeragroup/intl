// What the API answers in each language, written out by hand: the oracle the HTTP tests hold the server to. Money,
// dates, ranges and relative times are CLDR's, as Node's ICU writes them: U+00A0 where CLDR puts a no-break space
// (between digit groups, and between an amount and its symbol), U+2009 where it puts a thin space, U+2212 for minus where the locale writes a minus sign
// (Bokmål, Swedish and Finnish; English writes U+002D). Finnish has no narrow symbol for the krone, so its amounts read
// `NOK`. Every date is Oslo's: the server runs in New York, where midnight on 20 March in Oslo is still 19 March, and
// February's first Oslo midnight is still 31 January.

/** One locale's answers. */
export type ExpectedText = {
  /** `GET /greeting?name=Ingrid`. */
  readonly greeting: string;
  /** `GET /overdue?count=N`, by N. */
  readonly overdue: Readonly<Record<0 | 1 | 6 | 1500, string>>;
  /** `GET /invoices/INV-2026-0215`: paid, sent as eFaktura, 1,249.50 kroner. */
  readonly paid: {
    readonly status: string;
    readonly amount: string;
    readonly due: string;
    readonly period: string;
    readonly delivery: string;
    readonly sent: string;
  };
  /** `GET /invoices/INV-2026-0216`: overdue, sent by email, 2,310 kroner. */
  readonly overdueInvoice: { readonly status: string; readonly amount: string; readonly delivery: string };
  /** `GET /invoices/INV-2026-0217`: a credit note, sent by post, minus 412.30 kroner. */
  readonly credited: { readonly status: string; readonly amount: string; readonly delivery: string };
  /** The 404 for `GET /invoices/INV-2026-9999`. */
  readonly unknownInvoice: string;
  /** The 400 for a request that does not decode. */
  readonly invalidRequest: string;
};

/** Every locale's answers, by the locale `Content-Language` names. */
export const EXPECTED_TEXT = {
  en: {
    greeting: "Hello Ingrid, welcome back.",
    overdue: {
      0: "No invoices are overdue.",
      1: "1 invoice is overdue.",
      6: "6 invoices are overdue.",
      1500: "1,500 invoices are overdue.",
    },
    paid: {
      status: "Paid",
      amount: "kr 1,249.50",
      due: "Due on March 20, 2026",
      // CLDR's English interval pattern (since CLDR 42) puts U+2009, a thin space, on each side of the en dash.
      period: "February 1\u2009–\u200928",
      delivery: "Sent as eFaktura",
      sent: "3 weeks ago",
    },
    overdueInvoice: { status: "Overdue", amount: "kr 2,310.00", delivery: "Sent by email" },
    credited: { status: "Credited", amount: "-kr 412.30", delivery: "Sent by post" },
    unknownInvoice: "No invoice has the number INV-2026-9999.",
    invalidRequest: "This request is missing a parameter, or has one that is not valid.",
  },
  nb: {
    greeting: "Hei Ingrid, velkommen tilbake.",
    overdue: {
      0: "Ingen fakturaer er forfalt.",
      1: "1 faktura er forfalt.",
      6: "6 fakturaer er forfalt.",
      1500: "1 500 fakturaer er forfalt.",
    },
    paid: {
      status: "Betalt",
      amount: "1 249,50 kr",
      due: "Forfaller 20. mars 2026",
      period: "1.–28. februar",
      delivery: "Sendt som eFaktura",
      sent: "for 3 uker siden",
    },
    overdueInvoice: { status: "Forfalt", amount: "2 310,00 kr", delivery: "Sendt på e-post" },
    credited: { status: "Kreditert", amount: "−412,30 kr", delivery: "Sendt i posten" },
    unknownInvoice: "Ingen faktura har nummeret INV-2026-9999.",
    invalidRequest: "Forespørselen mangler en parameter, eller har en som ikke er gyldig.",
  },
  sv: {
    greeting: "Hej Ingrid, välkommen tillbaka.",
    overdue: {
      0: "Inga fakturor är förfallna.",
      1: "1 faktura är förfallen.",
      6: "6 fakturor är förfallna.",
      1500: "1 500 fakturor är förfallna.",
    },
    paid: {
      status: "Betald",
      amount: "1 249,50 kr",
      due: "Förfaller 20 mars 2026",
      period: "1–28 februari",
      delivery: "Skickad som e-faktura",
      sent: "för 3 veckor sedan",
    },
    overdueInvoice: { status: "Förfallen", amount: "2 310,00 kr", delivery: "Skickad med e-post" },
    credited: { status: "Krediterad", amount: "−412,30 kr", delivery: "Skickad med post" },
    unknownInvoice: "Ingen faktura har numret INV-2026-9999.",
    invalidRequest: "Begäran saknar en parameter eller har en som inte är giltig.",
  },
  fi: {
    greeting: "Hei Ingrid, tervetuloa takaisin.",
    overdue: {
      0: "Yhtään laskua ei ole erääntynyt.",
      1: "1 lasku on erääntynyt.",
      6: "6 laskua on erääntynyt.",
      1500: "1 500 laskua on erääntynyt.",
    },
    paid: {
      status: "Maksettu",
      amount: "1 249,50 NOK",
      due: "Erääntyy 20. maaliskuuta 2026",
      period: "1.–28. helmikuuta",
      delivery: "Lähetetty e-laskuna",
      sent: "3 viikkoa sitten",
    },
    overdueInvoice: { status: "Erääntynyt", amount: "2 310,00 NOK", delivery: "Lähetetty sähköpostilla" },
    credited: { status: "Hyvitetty", amount: "−412,30 NOK", delivery: "Lähetetty postitse" },
    unknownInvoice: "Laskua numerolla INV-2026-9999 ei löydy.",
    invalidRequest: "Pyynnöstä puuttuu parametri, tai jokin sen parametreista ei kelpaa.",
  },
} as const satisfies Readonly<Record<"en" | "nb" | "sv" | "fi", ExpectedText>>;
