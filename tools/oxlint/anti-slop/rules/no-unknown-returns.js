import { defineRule } from "@oxlint/plugins";

import {
  typeAliasReference,
  visibleTypeAliasBinding,
} from "../shared/type-aliases.js";

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
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
      if (type.type === "TSIntersectionType") {
        return type.types.every((member) =>
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

      const visibleBinding = visibleTypeAliasBinding(
        reference,
        type,
        context.sourceCode,
      );
      if (visibleBinding !== null) {
        const alias = visibleBinding.alias;
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
      }

      if (
        reference.namespace.length === 0 &&
        (reference.name === "Promise" || reference.name === "PromiseLike")
      ) {
        const value = reference.arguments[0];
        return value !== undefined && resolvesToUnknown(value, visited, bindings);
      }
      return false;
    };

    const checkReturnType = (node) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
