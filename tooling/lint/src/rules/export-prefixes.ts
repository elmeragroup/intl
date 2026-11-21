import type { ESTree, Rule } from "@oxlint/plugins";
// What an exported name's prefix promises, in the published packages' source:
//
// - `use*` is a React hook: a function that calls a hook (`use`, `useMemo`, another `use*`).
// - `get*` is async and server-only: it returns a Promise from a server module (`getT`, `getIntl`, `getFormat`).
// - `configure*` is one-time server wiring, so it lives in a server module (`configureRequestIntl`).
// - `compile*` is a build-time compiler, so it lives in the tools (`compileCatalog`), never in the runtime.
//
// A server module is `server.ts` or `<name>-server.ts(x)`: the runtime's server-only entries are named so.
//
// Every runtime export counts, a specifier export (`export { f as getThing }`) by its exported name against the
// declaration scope resolves it to. Where an export lives is checked in the exporting module (a client entry cannot
// re-export `getT`). A name that comes from another module is checked by shape where it is declared, since that module
// is linted too; so a re-export keeps its source name's prefix (`export { createIntl as getThing }` is reported) rather
// than this rule loading the other module.
import { basename } from "node:path";

import { containsInFunction, unwrap } from "../ast.ts";
import type { ExportedName } from "../exports.ts";
import { moduleExports } from "../exports.ts";
import { isPublishedSource, packageOf, TOOLS } from "../workspace.ts";

const SERVER_MODULE = /^(.+-)?server\.tsx?$/u;
const HOOK_CALL = /^use([A-Z0-9]|$)/u;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

function isFunction(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isPromiseType(type: ESTree.TSType | undefined): boolean {
  return (
    type?.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    type.typeName.name === "Promise"
  );
}

function callsHook(fn: FunctionNode): boolean {
  return (
    fn.body !== null &&
    containsInFunction(
      fn.body,
      (node) =>
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        HOOK_CALL.test(node.callee.name)
    )
  );
}

function returnsPromise(fn: FunctionNode): boolean {
  return fn.async || isPromiseType(fn.returnType?.typeAnnotation);
}

// The function an exported binding holds: a declaration, `const f = () => …`, or `const f = wrap(async () => …)`
// such as React's `cache`, whose result calls the wrapped function.
function heldFunction(init: ESTree.Expression | null): FunctionNode | undefined {
  if (init === null) {
    return undefined;
  }

  const value = unwrap(init);

  if (isFunction(value)) {
    return value;
  }

  if (value.type === "CallExpression" && value.arguments.length === 1) {
    const [argument] = value.arguments;

    return argument !== undefined && isFunction(argument) ? argument : undefined;
  }

  return undefined;
}

type Prefix = "use" | "get" | "configure" | "compile";

// The promise a name's prefix makes, if any.
function prefixOf(name: string): Prefix | undefined {
  if (HOOK_CALL.test(name) && name !== "use") {
    return "use";
  }

  return (["get", "configure", "compile"] as const).find(
    (prefix) => name.startsWith(prefix) && /^[A-Z]/u.test(name.charAt(prefix.length))
  );
}

// The function a local declaration holds, and the type its binding declares.
type DeclaredFunction = {
  readonly fn: FunctionNode | undefined;
  readonly annotation: ESTree.TSType | undefined;
};

function declaredFunction(
  declaration: ESTree.Function | ESTree.Class | ESTree.VariableDeclarator
): DeclaredFunction {
  if (declaration.type === "VariableDeclarator") {
    return {
      fn: heldFunction(declaration.init),
      annotation:
        declaration.id.type === "Identifier" ? declaration.id.typeAnnotation?.typeAnnotation : undefined,
    };
  }

  return { fn: isFunction(declaration) ? declaration : undefined, annotation: undefined };
}

/** Reports an exported `use*`, `get*`, `configure*` or `compile*` name that breaks its prefix's promise. */
export const exportPrefixes: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Exported names keep their prefix's promise: use* hook, get* async server-only, and so on.",
    },
    messages: {
      hook: "`{{name}}` is exported as a hook (`use*`) but does not call one: a React hook calls `use` or another `use*`; otherwise name it as a plain function (`create*`, `resolve*`).",
      getAsync:
        "`{{name}}` is a `get*` export, which means async and server-only: return a Promise (`async`, or a `Promise<…>` return type), or rename it.",
      server:
        "`{{name}}` ({{prefix}}*) is server-only by its prefix: export it from a server module (`server.ts`, `<name>-server.ts`), or rename it.",
      renamed:
        "`{{name}}` re-exports `{{source}}` under another prefix: a name's prefix is its promise (use* hook, get* async server-only), so keep the source's prefix or export a function that keeps the new one's.",
      compiler:
        "`{{name}}` is a `compile*` export: compilers run at build time and live in @elmeragroup/intl-tools; the runtime only decodes their output.",
    },
    schema: [],
  },
  create(context) {
    const pkg = packageOf(context.filename);

    if (pkg === undefined || !isPublishedSource(pkg, context.filename)) {
      return {};
    }

    const serverModule = SERVER_MODULE.test(basename(context.filename));
    const tools = pkg.name === TOOLS;

    // What the name's declaration must be: a hook, or a function returning a Promise. A foreign name is checked where
    // it is declared, so here it only keeps its prefix.
    function checkDeclaration({ name, node, origin }: ExportedName, prefix: Prefix): void {
      if (origin._tag === "Foreign") {
        if (prefixOf(origin.sourceName) !== prefix) {
          context.report({ node, messageId: "renamed", data: { name, source: origin.sourceName } });
        }

        return;
      }

      if (origin._tag !== "Local") {
        return;
      }

      const { fn, annotation } = declaredFunction(origin.declaration);
      const promised =
        (fn !== undefined && returnsPromise(fn)) ||
        (annotation?.type === "TSFunctionType" && isPromiseType(annotation.returnType.typeAnnotation));

      if (prefix === "use" && (fn === undefined || !callsHook(fn))) {
        context.report({ node, messageId: "hook", data: { name } });
      } else if (prefix === "get" && !promised) {
        context.report({ node, messageId: "getAsync", data: { name } });
      }
    }

    // Where the name may be exported from, checked in the exporting module.
    function checkPlace({ name, node }: ExportedName, prefix: Prefix): void {
      if ((prefix === "get" || prefix === "configure") && !serverModule) {
        context.report({ node, messageId: "server", data: { name, prefix } });
      } else if (prefix === "compile" && !tools) {
        context.report({ node, messageId: "compiler", data: { name } });
      }
    }

    return {
      Program(program) {
        for (const exported of moduleExports(program, context.sourceCode).names) {
          const prefix = prefixOf(exported.name);

          if (prefix !== undefined) {
            checkDeclaration(exported, prefix);
            checkPlace(exported, prefix);
          }
        }
      },
    };
  },
};
