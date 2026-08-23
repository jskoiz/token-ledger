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
    const aliases = new Map();

    const resolvesToObject = (
      type,
      shadowedAliases,
      visited = new Set(),
      bindings = new Map(),
    ) => {
      if (type.type === "TSObjectKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToObject(
          type.typeAnnotation,
          shadowedAliases,
          visited,
          bindings,
        );
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToObject(member, shadowedAliases, visited, bindings),
        );
      }

      const reference = aliasReference(type);
      if (reference === null) return false;

      const binding = bindings.get(reference.name);
      if (binding !== undefined) {
        return resolvesToObject(
          binding.type,
          shadowedAliases,
          visited,
          binding.bindings,
        );
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
      return resolvesToObject(
        alias.typeAnnotation,
        shadowedAliases,
        nextVisited,
        nextBindings,
      );
    };

    const checkParameters = (node) => {
      const shadowedAliases = lexicalTypeParameterNames(
        node,
        context.sourceCode.visitorKeys,
      );
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!resolvesToObject(annotation.typeAnnotation, shadowedAliases)) {
          continue;
        }
        context.report({
          node: annotation.typeAnnotation,
          messageId: "objectParameter",
          data: { parameter: parameterName(parameter, context.sourceCode) },
        });
      }
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
