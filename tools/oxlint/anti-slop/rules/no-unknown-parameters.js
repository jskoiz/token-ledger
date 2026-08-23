import { defineRule } from "@oxlint/plugins";

import {
  typeAliasReference,
  visibleTypeAliasBinding,
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

function parameterName(parameter, sourceText) {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
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

    const checkParameters = (node) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!resolvesToUnknown(annotation.typeAnnotation)) continue;
        const name = parameterName(
          parameter,
          context.sourceCode.getText(parameter),
        );
        if (name === "cause") continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
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
