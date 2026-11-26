// Type-level contracts of the tools' public API: the type-check runs these lines, nothing executes them. Each
// `@ts-expect-error` line must keep failing, so a type that starts accepting it fails the type-check.
import type { NextConfig } from "next";

import type { WithIntlOptions } from "../src/next";
import { withIntl } from "../src/next";

const options: WithIntlOptions = { dir: "/app" };
const phase = "phase-production-build";

// withIntl takes the idiomatic `satisfies NextConfig` literal, which sets neither field withIntl reads, and Next's
// phase function it returns gives back the literal's own type.
const named = { reactStrictMode: true, typescript: { ignoreBuildErrors: true } } satisfies NextConfig;
const wrapped: typeof named = withIntl(named, options)(phase);
void wrapped;
void withIntl({ reactStrictMode: true } satisfies NextConfig, options);
void withIntl({}, options);
const annotated: NextConfig = { reactStrictMode: true };
void withIntl(annotated, options);
void withIntl({ turbopack: { debugIds: true } } satisfies NextConfig, options);

// Another wrapper generic over NextConfig composes with it, returning Next's phase function.
export const withApp = <T extends NextConfig>(config: T): ((phase: string) => T) => withIntl(config, options);

// What withIntl returns is the phase function Next calls with the phase and a context, not a config: it is the
// next.config default export, outermost.
export const exported: (phase: string, context: { readonly defaultConfig: NextConfig }) => NextConfig =
  withIntl(named, options);
// @ts-expect-error -- the result is Next's phase function, not a config another plugin's NextConfig parameter takes
export const misused: NextConfig = withIntl(named, options);

// The phase function's result is the config's own type: it assigns where a NextConfig goes, and the caller's own
// fields read back.
const assigned: NextConfig = withIntl(named, options)(phase);
void assigned;
export const ownFields: readonly [boolean, boolean] = [
  withIntl(named, options)(phase).typescript.ignoreBuildErrors,
  withIntl({ reactStrictMode: true, turbopack: undefined }, options)(phase).reactStrictMode,
];
// `@next/mdx` is not resolvable from this package (it is no dependency here), so passing a result to `createMDX()` is
// not checked; `assigned` above covers the NextConfig parameter such a plugin takes.

// The fields withIntl reads keep their types.
// @ts-expect-error -- turbopack.root is a path
void withIntl({ turbopack: { root: 1 } }, options);
// @ts-expect-error -- turbopack is an object
void withIntl({ turbopack: "bad" }, options);

// What withIntl spreads must be a plain object: a spread drops the fields of anything else.
// @ts-expect-error -- not an object
void withIntl(123, options);
// @ts-expect-error -- not an object
void withIntl(false, options);
// @ts-expect-error -- turbopack as a function
void withIntl({ turbopack: () => ({}) }, options);
// @ts-expect-error -- turbopack as an array
void withIntl({ turbopack: [] }, options);
// @ts-expect-error -- turbopack as a Promise
void withIntl({ turbopack: Promise.resolve({}) }, options);
// @ts-expect-error -- a phase function, which Next accepts but withIntl cannot spread
void withIntl(() => ({}), options);
// @ts-expect-error -- withIntl's own result, a phase function: withIntl goes once, outermost
void withIntl(withIntl(named, options), options);
// @ts-expect-error -- an async phase function
void withIntl((_phase: string) => Promise.resolve({}), options);
// @ts-expect-error -- a Promise of a config
void withIntl(Promise.resolve({}), options);
const decorated = Object.assign(() => ({}), { outputFileTracingRoot: "/repo" });
// @ts-expect-error -- a function decorated with a field withIntl reads
void withIntl(decorated, options);
// @ts-expect-error -- a Promise decorated with a field withIntl reads
void withIntl(Object.assign(Promise.resolve({}), { outputFileTracingRoot: "/repo" }), options);
