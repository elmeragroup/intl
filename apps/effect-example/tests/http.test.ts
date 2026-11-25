import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPECTED_TEXT } from "./expected-text.ts";

// Unit under test: the API as a client gets it: `node src/main.ts`, run by Node as written (types stripped, no
// bundler), on a free port, asked over HTTP. Oracle: the text each language's answer must hold, written out by hand in
// expected-text.ts (CLDR's money, dates, ranges and relative times; the PO's translations), and the headers RFC 9110
// asks of a response that varies by Accept-Language: `Content-Language` (§8.5) naming the language, `Vary` (§12.5.5)
// naming the header among its field names, which compare case-insensitively, and, since the body is per request,
// `Cache-Control: private, no-store` (RFC 9111 §5.2.2). The server runs in New York, so a date written in Oslo's day proves the configured zone won over the host's.
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

// The Accept-Language a client in each locale sends: its language with a region first, as browsers and HTTP clients do.
const ACCEPT_LANGUAGE = {
  en: "en-US,en;q=0.9",
  nb: "nb-NO,nb;q=0.9,en;q=0.5",
  sv: "sv-SE,sv;q=0.9,en;q=0.5",
  fi: "fi-FI,fi;q=0.9,en;q=0.5",
} as const;

type Locale = keyof typeof ACCEPT_LANGUAGE;

const LOCALES = ["en", "nb", "sv", "fi"] as const satisfies ReadonlyArray<Locale>;

let server: ChildProcessByStdio<null, Readable, null> | undefined;
// The server's exit, captured when it starts: an exit before teardown has already happened by the time `afterAll` runs.
let exited: Promise<unknown> | undefined;
let origin = "";

// The server's origin, from the line it logs once it listens; the run fails if it exits first, with what it wrote.
function listeningOrigin(child: ChildProcessByStdio<null, Readable, null>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const listening = /Listening on (http:\/\/\S+)\r?\n/u.exec(output);

      if (listening?.[1] !== undefined) {
        resolve(listening[1]);
      }
    });
    child.once("exit", (code) => {
      reject(new Error(`The server exited (${String(code)}) before it listened:\n${output}`));
    });
  });
}

beforeAll(async () => {
  server = spawn(process.execPath, ["src/main.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: "0", TZ: "America/New_York" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  exited = once(server, "exit");
  origin = await listeningOrigin(server);
});

afterAll(async () => {
  if (server === undefined || exited === undefined) {
    return;
  }

  // A no-op on a process that has exited; its exit promise has then settled already.
  server.kill("SIGTERM");
  await exited;
});

function get(path: string, acceptLanguage?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage },
  });
}

// The field names a `Vary` value lists, lowercased: header names compare case-insensitively (RFC 9110 §5.1).
function varyNames(response: Response): ReadonlyArray<string> {
  return (response.headers.get("vary") ?? "").split(",").map((name) => name.trim().toLowerCase());
}

function expectLocalizedHeaders(response: Response, locale: Locale): void {
  expect(response.headers.get("content-language")).toBe(locale);
  expect(varyNames(response)).toContain("accept-language");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

describe.each(LOCALES.map((locale) => ({ locale })))("asked in $locale", ({ locale }) => {
  const expected = EXPECTED_TEXT[locale];
  const acceptLanguage = ACCEPT_LANGUAGE[locale];

  it("greets with the name in its placeholder", async () => {
    const response = await get("/greeting?name=Ingrid", acceptLanguage);

    expect(response.status).toBe(200);
    expectLocalizedHeaders(response, locale);
    expect(await response.json()).toEqual({ message: expected.greeting });
  });

  it.each([0, 1, 6, 1500] as const)(
    "counts %i overdue invoices in the language's plural forms",
    async (count) => {
      const response = await get(`/overdue?count=${String(count)}`, acceptLanguage);

      expect(response.status).toBe(200);
      expectLocalizedHeaders(response, locale);
      expect(await response.json()).toEqual({ message: expected.overdue[count] });
    }
  );

  it("writes a paid invoice: its label, money, due date, period, channel and age", async () => {
    const response = await get("/invoices/INV-2026-0215", acceptLanguage);

    expect(response.status).toBe(200);
    expectLocalizedHeaders(response, locale);
    expect(await response.json()).toEqual({
      id: "INV-2026-0215",
      customer: "Kari Nordmann",
      ...expected.paid,
    });
  });

  it.each([
    { id: "INV-2026-0216", invoice: expected.overdueInvoice, what: "an overdue invoice sent by email" },
    {
      id: "INV-2026-0217",
      invoice: expected.credited,
      what: "a credit note sent by post, its amount negative",
    },
  ])("writes $what", async ({ id, invoice }) => {
    const response = await get(`/invoices/${id}`, acceptLanguage);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(invoice);
  });

  it("answers an unknown invoice with a 404 that says so", async () => {
    const response = await get("/invoices/INV-2026-9999", acceptLanguage);

    expect(response.status).toBe(404);
    expectLocalizedHeaders(response, locale);
    expect(await response.json()).toEqual({
      _tag: "UnknownInvoice",
      invoiceId: "INV-2026-9999",
      message: expected.unknownInvoice,
    });
  });

  it.each([
    { path: "/greeting", what: "a missing name" },
    { path: "/overdue?count=-1", what: "a negative count" },
    { path: "/overdue?count=six", what: "a count that is no number" },
    { path: "/invoices/0215", what: "an invoice number of the wrong shape" },
    // Past the router's default limit for a path parameter (100 characters), which would answer a bare 404.
    { path: `/invoices/INV-${"1".repeat(120)}`, what: "an invoice number of 124 characters" },
  ])("answers $what with a 400 that says so", async ({ path }) => {
    const response = await get(path, acceptLanguage);

    expect(response.status).toBe(400);
    expectLocalizedHeaders(response, locale);
    expect(await response.json()).toEqual({ _tag: "InvalidRequest", message: expected.invalidRequest });
  });
});

describe("the lang parameter", () => {
  it("wins over Accept-Language", async () => {
    const response = await get("/greeting?name=Ingrid&lang=sv", ACCEPT_LANGUAGE.fi);

    expectLocalizedHeaders(response, "sv");
    expect(await response.json()).toEqual({ message: EXPECTED_TEXT.sv.greeting });
  });

  it("falls back to Accept-Language when it names a language the API does not ship", async () => {
    const response = await get("/greeting?name=Ingrid&lang=de", ACCEPT_LANGUAGE.nb);

    expectLocalizedHeaders(response, "nb");
    expect(await response.json()).toEqual({ message: EXPECTED_TEXT.nb.greeting });
  });

  it("falls back to Accept-Language when it is given twice", async () => {
    const response = await get("/greeting?name=Ingrid&lang=sv&lang=fi", ACCEPT_LANGUAGE.nb);

    expect(response.status).toBe(200);
    expectLocalizedHeaders(response, "nb");
    expect(await response.json()).toEqual({ message: EXPECTED_TEXT.nb.greeting });
  });

  it("picks the language of an error too", async () => {
    const response = await get("/invoices/INV-2026-9999?lang=fi", ACCEPT_LANGUAGE.en);

    expect(response.status).toBe(404);
    expectLocalizedHeaders(response, "fi");
    expect(await response.json()).toMatchObject({ message: EXPECTED_TEXT.fi.unknownInvoice });
  });
});

describe("a request without a language", () => {
  it("answers in English", async () => {
    const response = await get("/greeting?name=Ingrid");

    expectLocalizedHeaders(response, "en");
    expect(await response.json()).toEqual({ message: EXPECTED_TEXT.en.greeting });
  });
});

// RFC 9112 §3.2.1: a request target in origin-form is an absolute path, whose segments may be empty (RFC 9110 §4.1),
// so `//greeting` is a path, never a host. The API's policy, written in server.ts: duplicate slashes collapse, and it
// is answered as `/greeting`.
describe("a path with a doubled slash", () => {
  it("is answered as the single-slash path", async () => {
    const response = await get("//greeting?name=Ingrid", ACCEPT_LANGUAGE.nb);

    expect(response.status).toBe(200);
    expectLocalizedHeaders(response, "nb");
    expect(await response.json()).toEqual({ message: EXPECTED_TEXT.nb.greeting });
  });
});

// The status lines a connection has received so far, in order.
function statusLines(received: string): ReadonlyArray<string> {
  return [...received.matchAll(/^HTTP\/1\.1 (\d{3})/gmu)].map((match) => match[1] ?? "");
}

// RFC 9112 §9.3: a persistent connection carries the next request once a response is complete, so a body the server
// never reads must not hold up the request after it. The second request asks to close the connection (§9.6), so the
// server ends it after that response, and everything it answered is in once the socket ends.
describe("a keep-alive connection", () => {
  it("answers the next request after a POST whose body no route reads", async () => {
    const { hostname, port } = new URL(origin);
    const socket = connect(Number(port), hostname);
    let received = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    // Settles when the server ends the connection; the test's timeout is the hang guard.
    const ended = new Promise<void>((resolve, reject) => {
      socket.once("end", resolve);
      socket.once("error", reject);
    });

    try {
      // Queued until the socket connects. More than the socket and stream buffers hold, so a server that starts reading
      // a body it never finishes stalls the connection here.
      const body = "a".repeat(1_000_000);

      socket.write(
        `POST /nowhere HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`
      );
      socket.write(
        "GET /greeting?name=Ingrid HTTP/1.1\r\nHost: localhost\r\nAccept-Language: sv\r\nConnection: close\r\n\r\n"
      );

      await ended;
    } finally {
      socket.destroy();
    }

    expect(statusLines(received)).toEqual(["404", "200"]);
    expect(received).toContain(EXPECTED_TEXT.sv.greeting);
  });
});
