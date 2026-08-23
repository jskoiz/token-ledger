import { defineRule } from "@oxlint/plugins";



const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

function unwrapExpression(expression                   )                    {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function resolveVariable(
  sourceCode            ,
  identifier                            ,
)                  {
  let scope               = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function variableDeclarator(variable          )                                   {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

function isStableConstVariable(variable          , declarator                           )          {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    variable.references.every((reference) => reference.init || !reference.isWrite())
  );
}

function importedName(node             )                {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function importFrameworkValue(definition          )                     {
  if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
    return null;
  }
  const source = definition.parent.source.value;
  if (source !== "vitest" && source !== "@jest/globals") return null;
  if (definition.node.type === "ImportNamespaceSpecifier") {
    return { kind: "namespace", source };
  }
  const name = importedName(definition.node);
  const framework = source === "vitest" ? "vi" : "jest";
  return name === framework ? { kind: "framework", framework } : null;
}

function staticMember(node             )                {
  if (node.type !== "StaticMemberExpression" && node.type !== "MemberExpression") return null;
  if (node.computed) {
    return node.property.type === "Literal" && typeof node.property.value === "string"
      ? { object: node.object, property: node.property.value }
      : null;
  }
  return node.property.type === "Identifier"
    ? { object: node.object, property: node.property.name }
    : null;
}

function staticPropertyName(node             )                {
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

function bindingPropertyPath(pattern                   , name        )                {
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

function memberValue(value                         , property        )                     {
  if (value === null) return null;
  if (value.kind === "namespace") {
    const framework = value.source === "vitest" ? "vi" : "jest";
    return property === framework ? { kind: "framework", framework } : null;
  }
  if (value.kind === "framework" && moduleMockMethods.has(property)) {
    return { kind: "method", framework: value.framework, method: property };
  }
  return null;
}

function resolveFrameworkValue(
  sourceCode            ,
  expression                   ,
  visited = new Set(),
)                     {
  const current = unwrapExpression(expression);
  if (current.type === "Identifier") {
    if (
      (current.name === "vi" || current.name === "jest") &&
      sourceCode.isGlobalReference(current)
    ) {
      return { kind: "framework", framework: current.name };
    }

    const variable = resolveVariable(sourceCode, current);
    if (variable === null || variable.defs.length === 0) {
      return current.name === "vi" || current.name === "jest"
        ? { kind: "framework", framework: current.name }
        : null;
    }
    if (visited.has(variable)) return null;

    for (const definition of variable.defs) {
      const imported = importFrameworkValue(definition);
      if (imported !== null) return imported;
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
    const value = resolveFrameworkValue(sourceCode, declarator.init, nextVisited);
    const path = bindingPropertyPath(declarator.id, current.name);
    if (path === null) return null;
    return path.reduce((resolved, property) => memberValue(resolved, property), value);
  }

  const member = staticMember(current);
  if (member === null) return null;
  return memberValue(
    resolveFrameworkValue(sourceCode, member.object, visited),
    member.property,
  );
}

function moduleMockCall(sourceCode            , callee                   )          {
  const resolved = resolveFrameworkValue(sourceCode, callee);
  return resolved?.kind === "method" && moduleMockMethods.has(resolved.method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
