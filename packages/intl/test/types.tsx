// Type-check only (never executed; `pnpm type-check` covers test/): tsrs fails if a @ts-expect-error stops firing.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { CreateIntlOptions, Descriptor, NegotiateLocaleOptions } from "@elmeragroup/intl/core";
import { createIntl, msg, negotiateLocale } from "@elmeragroup/intl/core";
import { CurrentIntl } from "@elmeragroup/intl/effect";
import type { RequestConfig } from "@elmeragroup/intl/next/server";
import { createRequestConfig } from "@elmeragroup/intl/next/server";
import { Select, Val } from "@elmeragroup/intl/react";

import { english } from "./catalogs";

const intl = createIntl({ locale: "en", catalog: english(), timeZone: "UTC" });
// @ts-expect-error a catalog is compiled (a *.po import, loadCatalog): translations by source are not one
createIntl({ locale: "nb", catalog: { Hello: "Hei" }, timeZone: "UTC" });
// @ts-expect-error nor is the compiled shape built by hand, which only compileCatalog brands
createIntl({ locale: "nb", catalog: { v: 1, m: {} }, timeZone: "UTC" });
intl.t("Hello {name}", { name: "x" });
intl.t("Select all");
intl.t("Total {n, number}", { n: 1000 });
intl.t("Total {n, number}", { n: 1000n });
intl.t("{n, number} {n, plural, one {item} other {items}}", { n: 2 });
intl.t("Due {d, date, short} at {d, time, short}", { d: new Date(0) });
intl.t("{kind, select, a {A} other {B}}", { kind: "a" });
// @ts-expect-error a plain {x} takes text: a number names its format ({n, number})
intl.t("Total {n}", { n: 1000 });
// @ts-expect-error a plain {x} takes text: a date names its format ({d, date})
intl.t("On {d}", { d: new Date(0) });
// @ts-expect-error one argument cannot be both text and a number
intl.t("{n} {n, plural, one {item} other {items}}", { n: 2 });
// @ts-expect-error a date argument takes a Date
intl.t("On {d, date}", { d: "2026-01-01" });
// @ts-expect-error a select takes text
intl.t("{kind, select, a {A} other {B}}", { kind: 1 });
// @ts-expect-error misspelled placeholder
intl.t("Hello {name}", { nmae: "x" });
// @ts-expect-error missing values
intl.t("Hello {name}");
// @ts-expect-error plural needs a number
intl.t("{n, plural, one {#} other {#}}", { n: "1" });
// @ts-expect-error unexpected values on a plain message
intl.t("Select all", { x: 1 });
const dynamic: string = "x";
// @ts-expect-error a non-literal string cannot be extracted; use a msg() descriptor
intl.t(dynamic);
intl.t.from(msg("Descriptor", { context: "ok" }));
intl.t.from(msg("Hello {name}"), { name: "x" });
intl.t.from(msg("Total {n, number}"), { n: 1 });
// @ts-expect-error t.from types values from the descriptor's message: a plain {x} takes text
intl.t.from(msg("Total {n}"), { n: 1 });
// @ts-expect-error t.from requires the descriptor's values
intl.t.from(msg("Hello {name}"));
const either = (isFirst: boolean) => (isFirst ? msg("A {x}") : msg("B"));
intl.t.from(either(true), { x: "1" });
// @ts-expect-error a union of descriptors needs every member's values: the shown one may be "A {x}"
intl.t.from(either(true));
const shared = (isFirst: boolean) => (isFirst ? msg("A {id}") : msg("B {id} {user}"));
intl.t.from(shared(true), { id: "1", user: "u" });
// @ts-expect-error a union of descriptors needs every member's values, not only the shared ones
intl.t.from(shared(true), { id: "1" });
const STATUS = { open: msg("Open"), closed: msg("Closed", { context: "status" }) };
declare const status: keyof typeof STATUS;
intl.t.from(STATUS[status]);
const widened: Descriptor = msg("Hello {name}");
intl.t.from(widened, { name: 1 });
// @ts-expect-error a plain object is not a descriptor (only msg() makes one, so its text was extracted)
intl.t.from({ message: "Hand-made", context: undefined });
// @ts-expect-error descriptors go through t.from, so t() only ever sees literals
intl.t(msg("Wrong form"));
// @ts-expect-error msg() also needs a literal
msg(dynamic);
// @ts-expect-error null is not a message value (an untyped caller's null renders as nothing)
intl.t.from(msg("{v}"), { v: null });
// @ts-expect-error <Val> fills a plain {x}, which takes text
<Val n={1} />;
<Val name="x" />;
<Select kind="a" _a="A" _b="B" other="O" />;
// @ts-expect-error a select needs `other`, as ICU does
<Select kind="a" _a="A" />;
// @ts-expect-error a select takes text, as t("{kind, select, …}") does
<Select kind={1} _a="A" other="O" />;
// @ts-expect-error a branch is text
<Select kind="a" _a={1} other="O" />;

// The Effect service: `yield* CurrentIntl` is the IntlInstance, so `t` is typed from its literal as above.
const greet = Effect.gen(function* () {
  const { t } = yield* CurrentIntl;
  // @ts-expect-error a plain {x} takes text, read through the Effect service too
  t("Hello, {name}", { name: 1 });

  return t("Hello, {name}", { name: "Ada" });
});
// CurrentIntl.provide takes the options effect's E and R, and removes CurrentIntl from what the handler requires.
class RequestCookie extends Context.Service<RequestCookie, string>()("RequestCookie") {}
declare const intlOptions: Effect.Effect<CreateIntlOptions, "CatalogUnavailable", RequestCookie>;
const provided = greet.pipe(CurrentIntl.provide(intlOptions));
const _inferred: Effect.Effect<string, "CatalogUnavailable", RequestCookie> = provided;
// @ts-expect-error the options effect's requirement stays until the request provides it
// @effect-diagnostics-next-line missingEffectContext:off - a type test: the @ts-expect-error above is the assertion
const _unprovided: Effect.Effect<string, "CatalogUnavailable"> = provided;
const served = provided.pipe(Effect.provideService(RequestCookie, "nb"));
const _complete: Effect.Effect<string, "CatalogUnavailable"> = served;
// @ts-expect-error the options effect's failure stays in E
// @effect-diagnostics-next-line missingEffectError:off - a type test: the @ts-expect-error above is the assertion
const _infallible: Effect.Effect<string> = served;
// @ts-expect-error without CurrentIntl.provide the handler still requires CurrentIntl
// @effect-diagnostics-next-line missingEffectContext:off - a type test: the @ts-expect-error above is the assertion
const _unserved: Effect.Effect<string> = greet;
// CurrentIntl.layer discharges the CurrentIntl requirement and adds neither a failure nor a requirement of its own.
declare const fixedOptions: CreateIntlOptions;
const _fixed: Effect.Effect<string> = Effect.provide(greet, CurrentIntl.layer(fixedOptions));

// The request config resolves the whole IntlConfig: an adapter without a time zone would leave dates in the host's.
// @ts-expect-error createRequestConfig needs resolveTimeZone
createRequestConfig({ resolveLocale: () => "en", loadCatalog: () => Promise.resolve(english()) });
// A request config gives the server its onError: createRequestConfig's second argument, which the config it resolves
// carries, as a hand-written RequestConfig's may.
const adapter = {
  resolveLocale: () => "en",
  resolveTimeZone: () => "UTC",
  loadCatalog: () => Promise.resolve(english()),
};
createRequestConfig(adapter, { onError: (error, key) => [error.message, key] });
declare const resolvedConfig: Awaited<ReturnType<RequestConfig>>;
const _onError: ((error: Error, key: string) => void) | undefined = resolvedConfig.onError;
// @ts-expect-error onError is a function of the error and its key
createRequestConfig(adapter, { onError: "x" });

// negotiateLocale infers the locales from the list and checks the aliases against them, never widening the list.
declare const header: string | null;
const SHIPPED = ["en", "nb"] as const;
// @ts-expect-error an alias names a shipped locale, with an `as const` list
negotiateLocale(header, SHIPPED, { aliases: { no: "zz" } });
// @ts-expect-error an alias names a shipped locale, with an inline list
negotiateLocale(header, ["en", "nb"], { aliases: { no: "zz" } });
declare const wider: NegotiateLocaleOptions<"en" | "nb" | "zz">;
// @ts-expect-error options typed for more locales than the list
negotiateLocale(header, SHIPPED, wider);
// The result is exactly the list's locales or none, inferred, not narrowed to the alias targets nor widened. `Equal` is
// true only when each type is assignable to the other, where an annotation checks one direction alone. It passes an
// `any` result, which `_always` below rejects.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const negotiated = negotiateLocale(header, SHIPPED, { aliases: { no: "nb" } });
const _negotiated: Equal<typeof negotiated, "en" | "nb" | undefined> = true;
// An explicit list type alone is enough: the alias type defaults to it.
const _explicit: "en" | "nb" | undefined = negotiateLocale<"en" | "nb">(header, SHIPPED, {
  aliases: { no: "nb" },
});
// @ts-expect-error the header may accept none, so the caller picks its default
const _always: "en" | "nb" = negotiated;
