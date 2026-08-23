import { defineRule } from "@oxlint/plugins";

import {
  typeAliasReference,
  visibleTypeAlias,
} from "../shared/type-aliases.js";

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
    const resolvesToUnknown = (
      type,
      visited = new Set(),
      bindings = new Map(),
    ) => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(type.typeAnnotation, visited, bindings);
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToUnknown(member, visited, bindings),
        );
      }

      const reference = typeAliasReference(type);
      if (reference === null) return false;
      const binding = reference.namespace.length === 0
        ? bindings.get(reference.name)
        : undefined;
      if (binding !== undefined) {
        return resolvesToUnknown(binding.type, visited, binding.bindings);
      }

      const alias = visibleTypeAlias(reference, type, context.sourceCode);
      if (alias === null || visited.has(alias)) return false;
      const parameters = alias.typeParameters?.params ?? [];
      if (reference.arguments.length > parameters.length) return false;

      const nextBindings = new Map(bindings);
      for (const [index, parameter] of parameters.entries()) {
        const supplied = reference.arguments[index];
        const argument = supplied ?? parameter.default;
        if (argument === null || argument === undefined) return false;
        nextBindings.set(parameter.name.name, {
          type: argument,
          bindings: supplied === undefined ? new Map(nextBindings) : bindings,
        });
      }

      const nextVisited = new Set(visited);
      nextVisited.add(alias);
      return resolvesToUnknown(alias.typeAnnotation, nextVisited, nextBindings);
    };

    return {
      TSTypeAliasDeclaration(alias) {
        if (!resolvesToUnknown(alias.typeAnnotation, new Set([alias]))) return;
        context.report({
          node: alias.id,
          messageId: "unknownAlias",
          data: { alias: alias.id.name },
        });
      },
    };
  },
});
