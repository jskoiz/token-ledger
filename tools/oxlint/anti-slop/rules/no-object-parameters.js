import { defineRule } from "@oxlint/plugins";

import {
  typeAliasReference,
  visibleTypeAlias,
  visibleTypeInterfaceBinding,
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
    const resolvesToEmptyInterface = (interfaces, visited = new Set()) => {
      for (const declaration of interfaces) {
        if (visited.has(declaration) || declaration.body.body.length > 0) return false;
        const nextVisited = new Set(visited);
        nextVisited.add(declaration);
        for (const extended of declaration.extends ?? []) {
          const reference = typeAliasReference(extended);
          if (reference === null) return false;
          const binding = visibleTypeInterfaceBinding(
            reference,
            extended,
            context.sourceCode,
          );
          if (
            binding?.interfaces === undefined ||
            binding.interfaces === null ||
            !resolvesToEmptyInterface(binding.interfaces, nextVisited)
          ) {
            return false;
          }
        }
      }
      return true;
    };

    const resolvesToBroadType = (
      type,
      target,
      visited = new Set(),
      bindings = new Map(),
    ) => {
      const keyword = target === "object"
        ? "TSObjectKeyword"
        : target === "unknown"
          ? "TSUnknownKeyword"
          : null;
      if (keyword !== null && type.type === keyword) return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToBroadType(
          type.typeAnnotation,
          target,
          visited,
          bindings,
        );
      }
      if (type.type === "TSUnionType") {
        if (target === "empty-object") {
          return type.types.every((member) =>
            resolvesToBroadType(member, target, visited, bindings),
          );
        }
        return type.types.some((member) =>
          resolvesToBroadType(member, target, visited, bindings),
        );
      }
      if (type.type === "TSIntersectionType") {
        if (target === "empty-object") {
          return type.types.every((member) =>
            resolvesToBroadType(member, target, visited, bindings),
          );
        }
        if (target === "unknown") {
          return type.types.every((member) =>
            resolvesToBroadType(member, target, visited, bindings),
          );
        }
        let includesObject = false;
        for (const member of type.types) {
          if (resolvesToBroadType(member, "empty-object", visited, bindings)) {
            continue;
          }
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
      if (target === "empty-object") {
        if (type.type === "TSUnknownKeyword") return true;
        if (type.type === "TSTypeLiteral") return type.members.length === 0;
      }

      const reference = typeAliasReference(type);
      if (reference === null) return false;

      if (target === "empty-object") {
        const interfaceBinding = visibleTypeInterfaceBinding(
          reference,
          type,
          context.sourceCode,
        );
        if (interfaceBinding?.interfaces?.length > 0) {
          return resolvesToEmptyInterface(interfaceBinding.interfaces);
        }
      }

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
