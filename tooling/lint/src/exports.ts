// A module's runtime exports, enumerated once for every rule that reads them: each exported name, where to report it,
// and what it names. A local specifier (`export { f as g }`) is resolved through scope to its declaration; a name
// that comes from another module (`export { f } from "./m"`, or an imported binding exported again) records the name
// it has there. Type-only exports have no runtime name and are left out.
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { boundIdentifiers, moduleExportName, resolveVariable } from "./ast.ts";

/** What an exported name is bound to. */
export type ExportOrigin =
  /** A declaration in this module: a function, a class, or the declarator of a variable. */
  | {
      readonly _tag: "Local";
      readonly declaration: ESTree.Function | ESTree.Class | ESTree.VariableDeclarator;
    }
  /** A binding of another module, under the name it has there (`default` for a default import, `*` for a namespace). */
  | { readonly _tag: "Foreign"; readonly sourceName: string }
  /** The default export, or a name scope does not resolve. */
  | { readonly _tag: "Other" };

/** One runtime name a module exports. */
export type ExportedName = {
  /** The name importers use. */
  readonly name: string;
  /** Where a finding about this name is reported: the exported identifier or the specifier. */
  readonly node: ESTree.Node;
  readonly origin: ExportOrigin;
};

/** A module's runtime exports, and each `export * from` that hides some. */
export type ModuleExports = {
  readonly names: ReadonlyArray<ExportedName>;
  readonly exportAll: ReadonlyArray<ESTree.ExportAllDeclaration>;
};

function declarationNames(declaration: ESTree.Declaration): ReadonlyArray<ExportedName> {
  switch (declaration.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return declaration.id !== null && declaration.declare !== true
        ? [{ name: declaration.id.name, node: declaration.id, origin: { _tag: "Local", declaration } }]
        : [];
    case "VariableDeclaration":
      return declaration.declare === true
        ? []
        : declaration.declarations.flatMap((declarator) =>
            boundIdentifiers(declarator.id).map((identifier) => ({
              name: identifier.name,
              node: identifier,
              origin: { _tag: "Local", declaration: declarator } as const,
            }))
          );
    default:
      // Types, interfaces and `declare` forms have no runtime name.
      return [];
  }
}

// The declaration a local name resolves to, or the name it has in the module it was imported from.
function localOrigin(sourceCode: SourceCode, local: ESTree.Node, name: string): ExportOrigin {
  const definition = resolveVariable(sourceCode.getScope(local), name)?.defs[0];

  switch (definition?.type) {
    case "FunctionName":
    case "ClassName":
      return definition.node.type === "FunctionDeclaration" || definition.node.type === "ClassDeclaration"
        ? { _tag: "Local", declaration: definition.node }
        : { _tag: "Other" };
    case "Variable":
      return definition.node.type === "VariableDeclarator"
        ? { _tag: "Local", declaration: definition.node }
        : { _tag: "Other" };
    case "ImportBinding": {
      const specifier = definition.node;

      return {
        _tag: "Foreign",
        sourceName:
          specifier.type === "ImportSpecifier"
            ? moduleExportName(specifier.imported)
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*",
      };
    }
    default:
      return { _tag: "Other" };
  }
}

/**
 * Every runtime name a module exports.
 *
 * @param program - The module.
 * @param sourceCode - Its source code, whose scopes resolve local specifiers.
 * @returns The exported names, in source order, and the `export *` declarations.
 */
export function moduleExports(program: ESTree.Program, sourceCode: SourceCode): ModuleExports {
  const names: Array<ExportedName> = [];
  const exportAll: Array<ESTree.ExportAllDeclaration> = [];

  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      if (statement.declaration) {
        names.push(...declarationNames(statement.declaration));
      }

      for (const specifier of statement.specifiers) {
        if (specifier.exportKind === "type") {
          continue;
        }

        const localName = moduleExportName(specifier.local);
        names.push({
          name: moduleExportName(specifier.exported),
          node: specifier.exported,
          origin:
            statement.source === null
              ? localOrigin(sourceCode, specifier.local, localName)
              : { _tag: "Foreign", sourceName: localName },
        });
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      names.push({ name: "default", node: statement, origin: { _tag: "Other" } });
    } else if (statement.type === "ExportAllDeclaration" && statement.exportKind !== "type") {
      if (statement.exported) {
        names.push({
          name: moduleExportName(statement.exported),
          node: statement,
          origin: { _tag: "Foreign", sourceName: "*" },
        });
      } else {
        exportAll.push(statement);
      }
    }
  }

  return { names, exportAll };
}
