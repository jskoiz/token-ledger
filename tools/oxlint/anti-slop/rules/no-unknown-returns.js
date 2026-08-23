import { defineRule } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.js";

function aliasReference(type) {
  if (type.type === "TSParenthesizedType") {
    return aliasReference(type.typeAnnotation);
  }
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
    return null;
  }
  return {
    name: type.typeName.name,
    arguments: type.typeArguments?.params ?? [],
  };
}

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
    const aliases = new Map();

    const resolvesToUnknown = (
      type,
      shadowedAliases,
      visited = new Set(),
      bindings = new Map(),
    ) => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(
          type.typeAnnotation,
          shadowedAliases,
          visited,
          bindings,
        );
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToUnknown(member, shadowedAliases, visited, bindings),
        );
      }

      const reference = aliasReference(type);
      if (reference === null) return false;

      const binding = bindings.get(reference.name);
      if (binding !== undefined) {
        return resolvesToUnknown(
          binding.type,
          shadowedAliases,
          visited,
          binding.bindings,
        );
      }
      if (reference.name === "Promise" || reference.name === "PromiseLike") {
        const value = reference.arguments[0];
        return value !== undefined &&
          resolvesToUnknown(value, shadowedAliases, visited, bindings);
      }
      if (visited.has(reference.name) || shadowedAliases.has(reference.name)) {
        return false;
      }

      const alias = aliases.get(reference.name);
      if (alias === undefined) return false;
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
      nextVisited.add(reference.name);
      return resolvesToUnknown(
        alias.typeAnnotation,
        shadowedAliases,
        nextVisited,
        nextBindings,
      );
    };

    const checkReturnType = (node) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (
        !resolvesToUnknown(
          annotation.typeAnnotation,
          lexicalTypeParameterNames(node, context.sourceCode.visitorKeys),
        )
      ) {
        return;
      }
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        aliases.clear();
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type === "TSTypeAliasDeclaration") {
            aliases.set(declaration.id.name, declaration);
          }
        }
      },
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
