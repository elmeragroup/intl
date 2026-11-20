// Generic child iteration over oxc's ESTree AST. The node types are precise, but walking every child needs the
// fields `visitorKeys` names, which TypeScript cannot index: this module is the one untyped seam.
import type { Node } from "oxc-parser";
import { visitorKeys } from "oxc-parser";

/**
 * The child nodes of an AST node, in source order.
 *
 * @param node - The parent node.
 * @returns Its children.
 */
export function childNodes(node: Node): Array<Node> {
  const keys = visitorKeys[node.type] ?? [];
  const children: Array<Node> = [];
  for (const key of keys) {
    const value: unknown = Object.getOwnPropertyDescriptor(node, key)?.value;
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (isNode(candidate)) {
        children.push(candidate);
      }
    }
  }

  return children;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
