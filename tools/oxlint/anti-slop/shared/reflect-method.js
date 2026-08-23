function unwrapExpression(expression) {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function variableDeclarator(variable) {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  return definition?.type === "Variable" &&
      definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

function isStableConstVariable(variable, declarator) {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    variable.references.every((reference) => reference.init || !reference.isWrite())
  );
}

function staticMember(node) {
  if (node.type !== "StaticMemberExpression" && node.type !== "MemberExpression") {
    return null;
  }
  if (node.computed) {
    return node.property.type === "Literal" &&
        typeof node.property.value === "string"
      ? { object: node.object, property: node.property.value }
      : null;
  }
  return node.property.type === "Identifier"
    ? { object: node.object, property: node.property.name }
    : null;
}

function staticPropertyName(node) {
  if (node.computed) {
    return node.key.type === "Literal" && typeof node.key.value === "string"
      ? node.key.value
      : null;
  }
  return node.key.type === "Identifier"
    ? node.key.name
    : node.key.type === "Literal" && typeof node.key.value === "string"
      ? node.key.value
      : null;
}

function bindingPropertyPath(pattern, name) {
  if (pattern.type === "AssignmentPattern") {
    return bindingPropertyPath(pattern.left, name);
  }
  if (pattern.type === "Identifier") return pattern.name === name ? [] : null;
  if (pattern.type !== "ObjectPattern") return null;
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const propertyName = staticPropertyName(property);
    if (propertyName === null) continue;
    const nested = bindingPropertyPath(property.value, name);
    if (nested !== null) return [propertyName, ...nested];
  }
  return null;
}

function isGlobalIdentifier(sourceCode, expression, name) {
  if (expression.type !== "Identifier" || expression.name !== name) return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0;
}

function isGlobalReflect(sourceCode, expression) {
  if (isGlobalIdentifier(sourceCode, expression, "Reflect")) return true;
  const member = staticMember(expression);
  return (
    member?.property === "Reflect" &&
    isGlobalIdentifier(sourceCode, member.object, "globalThis")
  );
}

function memberValue(value, property) {
  return value?.kind === "reflect"
    ? { kind: "method", method: property }
    : null;
}

function resolveReflectValue(sourceCode, expression, visited = new Set()) {
  const current = unwrapExpression(expression);
  if (isGlobalReflect(sourceCode, current)) return { kind: "reflect" };
  if (current.type === "Identifier") {
    const variable = resolveVariable(sourceCode, current);
    if (
      variable === null ||
      variable.defs.length === 0 ||
      visited.has(variable)
    ) {
      return null;
    }
    const declarator = variableDeclarator(variable);
    if (
      declarator === null ||
      declarator.init === null ||
      !isStableConstVariable(variable, declarator)
    ) {
      return null;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(variable);
    const value = resolveReflectValue(sourceCode, declarator.init, nextVisited);
    const path = bindingPropertyPath(declarator.id, current.name);
    if (path === null) return null;
    return path.reduce(
      (resolved, property) => memberValue(resolved, property),
      value,
    );
  }

  const member = staticMember(current);
  if (member === null) return null;
  return memberValue(
    resolveReflectValue(sourceCode, member.object, visited),
    member.property,
  );
}

/** Reports whether a call target resolves to one method on the global Reflect object. */
export function isGlobalReflectMethodCall(sourceCode, callee, methodName) {
  const resolved = resolveReflectValue(sourceCode, callee);
  return resolved?.kind === "method" && resolved.method === methodName;
}
