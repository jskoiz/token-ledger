import { defineRule } from "@oxlint/plugins";

import {
  typeAliasReference,
  visibleTypeAlias,
} from "../shared/type-aliases.js";

function parameterAnnotation(parameter) {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter, sourceCode) {
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
    },
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
    },
  },
  createOnce(context) {
    const resolvesToBroadType = (
      type,
      target,
      visited = new Set(),
      bindings = new Map(),
    ) => {
      const keyword = target === "object"
        ? "TSObjectKeyword"
        : "TSUnknownKeyword";
      if (type.type === keyword) return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToBroadType(
          type.typeAnnotation,
          target,
          visited,
          bindings,
        );
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToBroadType(member, target, visited, bindings),
        );
      }
      if (type.type === "TSIntersectionType") {
        if (target === "unknown") {
          return type.types.every((member) =>
            resolvesToBroadType(member, target, visited, bindings),
          );
        }
        let includesObject = false;
        for (const member of type.types) {
          if (resolvesToBroadType(member, "object", visited, bindings)) {
            includesObject = true;
          } else if (
            !resolvesToBroadType(member, "unknown", visited, bindings)
          ) {
            return false;
          }
        }
        return includesObject;
      }

      const reference = typeAliasReference(type);
      if (reference === null) return false;

      const binding = reference.namespace.length === 0
        ? bindings.get(reference.name)
        : undefined;
      if (binding !== undefined) {
        return resolvesToBroadType(
          binding.type,
          target,
          visited,
          binding.bindings,
        );
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
      return resolvesToBroadType(
        alias.typeAnnotation,
        target,
        nextVisited,
        nextBindings,
      );
    };

    const resolvesToObject = (type) => resolvesToBroadType(type, "object");

    const checkParameters = (node) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!resolvesToObject(annotation.typeAnnotation)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "objectParameter",
          data: { parameter: parameterName(parameter, context.sourceCode) },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
