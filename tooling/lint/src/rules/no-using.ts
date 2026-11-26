// The runtime's floor is ES2022 (packages/intl/tsconfig.floor.json), and `using` and `await using` (explicit resource
// management, later than ES2022) are not on it. The type-check passes them, because the `esnext.disposable`
// declarations it cannot drop mark native iterators and generators disposable, and tsdown lowers them to calls of the
// value's `[Symbol.dispose]`, which throws `TypeError` on an engine without native disposal. `.oxlintrc.json` enables
// this rule for `packages/intl/src` only.
import type { Rule } from "@oxlint/plugins";

/** Reports a `using` or `await using` declaration. */
export const noUsing: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Declare no `using` or `await using` binding below the runtime's ES2022 floor." },
    messages: {
      using:
        "`{{kind}}` is not available on the runtime's ES2022 floor: iterate with for…of and exit early (break or return closes the iterator), or run the cleanup explicitly in try/finally.",
    },
    schema: [],
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind === "using" || node.kind === "await using") {
          context.report({ node, messageId: "using", data: { kind: node.kind } });
        }
      },
    };
  },
};
