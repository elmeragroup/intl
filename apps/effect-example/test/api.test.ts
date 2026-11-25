import * as OpenApi from "effect/http-api/OpenApi";
import { describe, expect, it } from "vitest";

import { Api } from "../src/api.ts";

// Unit under test: the API's contract, api.ts, imported alone, as a client or a docs build takes it (no catalog, no
// loader, no server; `.oxlintrc.json` keeps its imports so), and the OpenAPI document effect generates from it.
// Oracle: the API's documented surface, the README's endpoint table: three GET endpoints, each taking the optional
// `lang` query parameter that picks the answer's language.
describe("the API's OpenAPI document", () => {
  const document = OpenApi.fromApi(Api);

  it.each(["/greeting", "/overdue", "/invoices/{id}"])("lists the optional lang parameter on %s", (path) => {
    expect(document.paths[path]?.get?.parameters).toContainEqual(
      expect.objectContaining({ name: "lang", in: "query", required: false })
    );
  });
});
