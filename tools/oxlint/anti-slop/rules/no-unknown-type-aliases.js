import { defineRule } from "@oxlint/plugins";

import {
  typeAliasReference,
  visibleTypeAlias,
} from "../shared/type-aliases.js";
import { createUnknownTypeResolver } from "../shared/unknown-types.js";

function isInsideTypeAliasDeclaration(node) {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (current.type === "TSTypeAliasDeclaration") return true;
    current = current.parent;
  }
  return false;
}

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  createOnce(context) {
    const resolvesToUnknown = createUnknownTypeResolver(context);

    const report = (node, alias) => {
      context.report({
        node,
        messageId: "unknownAlias",
        data: { alias },
      });
    };

    return {
      TSTypeAliasDeclaration(alias) {
        if (!resolvesToUnknown(alias.typeAnnotation, new Set([alias]))) return;
        report(alias.id, alias.id.name);
      },
      TSTypeReference(node) {
        if (isInsideTypeAliasDeclaration(node)) return;
        const reference = typeAliasReference(node);
        if (reference === null) return;
        const alias = visibleTypeAlias(reference, node, context.sourceCode);
        if (alias === null) return;
        const parameters = alias.typeParameters?.params ?? [];
        if (reference.arguments.length >= parameters.length) return;
        if (resolvesToUnknown(alias.typeAnnotation, new Set([alias]))) return;
        if (!resolvesToUnknown(node)) return;
        report(node, reference.name);
      },
    };
  },
});
