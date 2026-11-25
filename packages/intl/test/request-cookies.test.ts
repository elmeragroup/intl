import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

import { describe, expect, it } from "vitest";

import type { CookieEntry } from "../src/request-cookies";
import { cookieHeader } from "../src/request-cookies";

// A store's entries as Next's own cookie classes produce them, which is what `cookies().getAll()` lists: a request
// parsed from its header, then the writes a server action (or a proxy, through the response) makes.
function responseStore(write: (store: ResponseCookies) => void): ReadonlyArray<CookieEntry> {
  const store = new ResponseCookies(new Headers());
  write(store);

  return store.getAll();
}

// Unit under test: the `cookie` header createRequestConfig (`/next/server`) hands the adapter, written from Next's
// cookie store, because inside a server action only `cookies()` holds the cookie the action set. Oracle: Next's own
// request-cookie format (`stringifyCookie` in next/dist/compiled/@edge-runtime/cookies, which writes the request
// header: `name=` plus the URI-encoded value, empty when there is none, pairs joined by "; "), written out by hand
// below, over entries Next's own classes produced.
describe("cookieHeader", () => {
  it.each([
    [
      "a parsed header",
      () => new RequestCookies(new Headers({ cookie: "locale=en; theme=dark" })).getAll(),
      "locale=en; theme=dark",
    ],
    // Next's parser reads a pair without `=` as "true" and drops one whose value does not URI-decode.
    [
      "a parsed bare name and an undecodable value",
      () => new RequestCookies(new Headers({ cookie: "bare; bad=%E0%A4%A" })).getAll(),
      "bare=true",
    ],
    [
      "a request cookie deleted from the store",
      () => {
        const store = new RequestCookies(new Headers({ cookie: "locale=en; theme=dark" }));
        store.delete("locale");

        return store.getAll();
      },
      "theme=dark",
    ],
    ["a set empty value", () => responseStore((store) => store.set("flag", "")), "flag="],
    // ResponseCookies.delete lists the cookie as a set empty value with a past expiry: indistinguishable from `flag`.
    [
      "a deleted response cookie",
      () => responseStore((store) => store.set("locale", "nb").delete("locale")),
      "locale=",
    ],
    // `;` would start another pair and `=` another value; `%` and non-ASCII are what URI-encoding exists for.
    [
      "a value with ; = % and non-ASCII",
      () => responseStore((store) => store.set("note", "a;b=c%d æ")),
      "note=a%3Bb%3Dc%25d%20%C3%A6",
    ],
    // The type admits an entry without `value` (what Next lists for a proxy's `flag=`): sent as `name=`, as Next sends it.
    ["an entry without a value", (): ReadonlyArray<CookieEntry> => [{ name: "flag" }], "flag="],
    ["an empty store", () => new RequestCookies(new Headers()).getAll(), null],
  ] as const)("serializes %s", (_case, entries, header) => {
    expect(cookieHeader(entries())).toBe(header);
  });

  // A proxy's `Set-Cookie: flag=; Path=/` merged into the store as Next merges a proxy's cookies
  // (mergeMiddlewareCookies in next/dist/server/async-storage/request-store.js: a ResponseCookies parsed from the
  // Set-Cookie header, each of its entries set into the request's RequestCookies, which rewrites the request's `cookie`
  // header on every set). Oracle: that header, as Next itself wrote it for the store, whatever shape its entries take.
  it("serializes a proxy's flag= merged into the store as the header Next wrote for it", () => {
    const setCookie = new Headers();
    setCookie.append("set-cookie", "flag=; Path=/");
    const request = new Headers({ cookie: "locale=nb" });
    const store = new RequestCookies(request);
    for (const cookie of new ResponseCookies(setCookie).getAll()) {
      store.set(cookie);
    }
    const written = request.get("cookie");

    expect(written).not.toBe("locale=nb");
    expect(cookieHeader(store.getAll())).toBe(written);
  });

  // The adapter reads the header with a cookie parser; Next's own (the one `cookies()` uses) must read back the store.
  it("writes a header Next's RequestCookies parses back to the same cookies", () => {
    const entries = [
      { name: "locale", value: "nb" },
      { name: "flag", value: "" },
      { name: "note", value: "a;b=c%d æ" },
    ];
    const parsed = new RequestCookies(new Headers({ cookie: cookieHeader(entries) ?? "" }));

    expect(Object.fromEntries(parsed.getAll().map(({ name, value }) => [name, value]))).toEqual({
      locale: "nb",
      flag: "",
      note: "a;b=c%d æ",
    });
  });
});
