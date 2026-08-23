import {
  typeAliasReference,
  visibleTypeAliasBinding,
} from "./type-aliases.js";

/** Build a lexical alias-aware resolver for contracts that collapse to unknown. */
export function createUnknownTypeResolver(
  context,
  { unwrapPromiseLike = false } = {},
) {
  const resolveComparisonType = (
    type,
    bindings,
    visited = new Set(),
  ) => {
    if (type.type === "TSParenthesizedType") {
      return resolveComparisonType(type.typeAnnotation, bindings, visited);
    }
    if (visited.has(type)) return type;

    const reference = typeAliasReference(type);
    if (reference === null) return type;

    if (reference.namespace.length === 0 && reference.arguments.length === 0) {
      const substitution = bindings.get(reference.name);
      if (substitution !== undefined) {
        const nextVisited = new Set(visited);
        nextVisited.add(type);
        return resolveComparisonType(
          substitution.type,
          substitution.bindings,
          nextVisited,
        );
      }
    }

    const visibleBinding = visibleTypeAliasBinding(
      reference,
      type,
      context.sourceCode,
    );
    if (visibleBinding?.alias === null || visibleBinding?.alias === undefined) {
      return type;
    }

    const alias = visibleBinding.alias;
    if (visited.has(alias)) return type;
    const parameters = alias.typeParameters?.params ?? [];
    if (reference.arguments.length > parameters.length) return type;

    const nextBindings = new Map(bindings);
    for (const [index, parameter] of parameters.entries()) {
      const supplied = reference.arguments[index];
      const argument = supplied ?? parameter.default;
      if (argument === null || argument === undefined) return type;
      nextBindings.set(parameter.name.name, {
        type: argument,
        bindings: supplied === undefined ? new Map(nextBindings) : bindings,
      });
    }

    const nextVisited = new Set(visited);
    nextVisited.add(alias);
    return resolveComparisonType(alias.typeAnnotation, nextBindings, nextVisited);
  };

  const literalValue = (type) => {
    if (type.type !== "TSLiteralType") return null;
    const literal = type.literal;
    if (literal.type === "Literal") {
      const kind = typeof literal.value === "string"
        ? "StringLiteral"
        : typeof literal.value === "number"
          ? "NumericLiteral"
          : typeof literal.value === "boolean"
            ? "BooleanLiteral"
            : typeof literal.value === "bigint"
              ? "BigIntLiteral"
              : null;
      return kind === null ? null : { kind, value: literal.value };
    }
    if (
      literal.type !== "StringLiteral" &&
      literal.type !== "NumericLiteral" &&
      literal.type !== "BooleanLiteral" &&
      literal.type !== "BigIntLiteral"
    ) {
      return null;
    }
    return { kind: literal.type, value: literal.value };
  };

  const primitiveKind = (type) => {
    switch (type.type) {
      case "TSStringKeyword":
        return "StringLiteral";
      case "TSNumberKeyword":
        return "NumericLiteral";
      case "TSBooleanKeyword":
        return "BooleanLiteral";
      case "TSBigIntKeyword":
        return "BigIntLiteral";
      default:
        return null;
    }
  };

  const isDefinitelyAssignable = (
    source,
    target,
    bindings,
    visited = new Set(),
  ) => {
    const sourceType = resolveComparisonType(source, bindings, visited);
    const targetType = resolveComparisonType(target, bindings, visited);
    if (sourceType === targetType) return true;
    if (sourceType.type === "TSNeverKeyword") return true;
    if (
      targetType.type === "TSAnyKeyword" ||
      targetType.type === "TSUnknownKeyword"
    ) {
      return true;
    }
    if (sourceType.type === "TSAnyKeyword") return null;
    if (sourceType.type === "TSUnknownKeyword") return false;
    if (visited.has(sourceType) || visited.has(targetType)) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(sourceType);
    nextVisited.add(targetType);

    if (targetType.type === "TSUnionType") {
      let undecidable = false;
      for (const member of targetType.types) {
        const result = isDefinitelyAssignable(
          sourceType,
          member,
          bindings,
          nextVisited,
        );
        if (result === true) return true;
        if (result === null) undecidable = true;
      }
      return undecidable ? null : false;
    }
    if (sourceType.type === "TSUnionType") {
      let undecidable = false;
      for (const member of sourceType.types) {
        const result = isDefinitelyAssignable(
          member,
          targetType,
          bindings,
          nextVisited,
        );
        if (result === false) return false;
        if (result === null) undecidable = true;
      }
      return undecidable ? null : true;
    }
    if (targetType.type === "TSIntersectionType") {
      let undecidable = false;
      for (const member of targetType.types) {
        const result = isDefinitelyAssignable(
          sourceType,
          member,
          bindings,
          nextVisited,
        );
        if (result === false) return false;
        if (result === null) undecidable = true;
      }
      return undecidable ? null : true;
    }
    if (sourceType.type === "TSIntersectionType") {
      let undecidable = false;
      for (const member of sourceType.types) {
        const result = isDefinitelyAssignable(
          member,
          targetType,
          bindings,
          nextVisited,
        );
        if (result === true) return true;
        if (result === null) undecidable = true;
      }
      return undecidable ? null : false;
    }

    const sourceLiteral = literalValue(sourceType);
    const targetLiteral = literalValue(targetType);
    if (sourceLiteral !== null) {
      if (targetLiteral !== null) {
        return (
          sourceLiteral.kind === targetLiteral.kind &&
          sourceLiteral.value === targetLiteral.value
        );
      }
      return primitiveKind(targetType) === sourceLiteral.kind;
    }
    if (targetLiteral !== null) return false;
    const sourcePrimitive = primitiveKind(sourceType);
    const targetPrimitive = primitiveKind(targetType);
    if (sourcePrimitive !== null && targetPrimitive !== null) {
      return sourcePrimitive === targetPrimitive;
    }
    if (sourcePrimitive !== null) {
      return typeAliasReference(targetType) === null ? false : null;
    }
    if (targetPrimitive !== null) {
      return typeAliasReference(sourceType) === null ? false : null;
    }

    if (targetType.type === "TSObjectKeyword") {
      return (
        sourceType.type === "TSObjectKeyword" ||
        sourceType.type === "TSTypeLiteral" ||
        sourceType.type === "TSArrayType" ||
        sourceType.type === "TSFunctionType"
      );
    }
    if (sourceType.type === "TSObjectKeyword") {
      return targetType.type === "TSObjectKeyword";
    }
    return null;
  };

  const unionKind = (kinds) => {
    if (kinds.includes("any")) return "any";
    if (kinds.includes("unknown")) return "unknown";
    return kinds.every((kind) => kind === "never") ? "never" : "other";
  };

  const intersectionKind = (kinds) => {
    if (kinds.includes("never")) return "never";
    if (kinds.includes("any")) return "any";
    return kinds.every((kind) => kind === "unknown") ? "unknown" : "other";
  };

  const resolveTopKind = (
    type,
    visited = new Set(),
    bindings = new Map(),
  ) => {
    if (type.type === "TSUnknownKeyword") return "unknown";
    if (type.type === "TSAnyKeyword") return "any";
    if (type.type === "TSNeverKeyword") return "never";
    if (type.type === "TSParenthesizedType") {
      return resolveTopKind(type.typeAnnotation, visited, bindings);
    }
    if (type.type === "TSConditionalType") {
      const checkType = resolveComparisonType(type.checkType, bindings);
      const checkReference = typeAliasReference(type.checkType);
      const isBoundNakedCheck =
        checkReference?.namespace.length === 0 &&
        checkReference.arguments.length === 0 &&
        bindings.has(checkReference.name);
      if (checkType.type === "TSNeverKeyword" && isBoundNakedCheck) {
        return "never";
      }

      const trueKind = () => resolveTopKind(type.trueType, visited, bindings);
      const falseKind = () => resolveTopKind(type.falseType, visited, bindings);

      const evaluateBranch = (candidate) => {
        const selected = isDefinitelyAssignable(
          candidate,
          type.extendsType,
          bindings,
        );
        if (selected === true) return trueKind();
        if (selected === false) return falseKind();
        const consequent = trueKind();
        const alternate = falseKind();
        return consequent === alternate ? consequent : "other";
      };

      if (checkType.type === "TSAnyKeyword") {
        return unionKind([trueKind(), falseKind()]);
      }
      if (
        checkType.type === "TSUnionType" &&
        isBoundNakedCheck
      ) {
        return unionKind(checkType.types.map((member) => evaluateBranch(member)));
      }
      return evaluateBranch(checkType);
    }
    if (type.type === "TSUnionType") {
      return unionKind(
        type.types.map((member) => resolveTopKind(member, visited, bindings)),
      );
    }
    if (type.type === "TSIntersectionType") {
      return intersectionKind(
        type.types.map((member) => resolveTopKind(member, visited, bindings)),
      );
    }

    const reference = typeAliasReference(type);
    if (reference === null) return "other";

    const binding = reference.namespace.length === 0
      ? bindings.get(reference.name)
      : undefined;
    if (binding !== undefined) {
      return resolveTopKind(binding.type, visited, binding.bindings);
    }

    const visibleBinding = visibleTypeAliasBinding(
      reference,
      type,
      context.sourceCode,
    );
    if (visibleBinding !== null) {
      const alias = visibleBinding.alias;
      if (alias === null || visited.has(alias)) return "other";
      const parameters = alias.typeParameters?.params ?? [];
      if (reference.arguments.length > parameters.length) return "other";

      const nextBindings = new Map(bindings);
      for (const [index, parameter] of parameters.entries()) {
        const supplied = reference.arguments[index];
        const argument = supplied ?? parameter.default;
        if (argument === null || argument === undefined) return "other";
        nextBindings.set(parameter.name.name, {
          type: argument,
          bindings: supplied === undefined ? new Map(nextBindings) : bindings,
        });
      }

      const nextVisited = new Set(visited);
      nextVisited.add(alias);
      return resolveTopKind(alias.typeAnnotation, nextVisited, nextBindings);
    }

    if (
      unwrapPromiseLike &&
      reference.namespace.length === 0 &&
      (reference.name === "Promise" || reference.name === "PromiseLike")
    ) {
      const value = reference.arguments[0];
      return value === undefined
        ? "other"
        : resolveTopKind(value, visited, bindings);
    }
    return "other";
  };

  const resolvesToUnknown = (
    type,
    visited = new Set(),
    bindings = new Map(),
  ) => resolveTopKind(type, visited, bindings) === "unknown";

  return resolvesToUnknown;
}
