import { defineRule } from "@oxlint/plugins";



const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

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

function importedName(node             )                {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function isTestFrameworkObject(
  sourceCode            ,
  expression                   ,
)                                           {
  if (expression.type !== "Identifier") return false;
  if (
    (expression.name === "vi" || expression.name === "jest") &&
    sourceCode.isGlobalReference(expression)
  ) {
    return true;
  }

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) {
    return expression.name === "vi" || expression.name === "jest";
  }
  return variable.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      return false;
    }
    const source = definition.parent.source.value;
    const name = importedName(definition.node);
    return (source === "vitest" && name === "vi") || (source === "@jest/globals" && name === "jest");
  });
}

function moduleMockCall(sourceCode            , callee                   )          {
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;
  if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
  const property = callee.property;
  const method = callee.computed
    ? property.type === "Literal" &&
      (property.value === "doMock" ||
        property.value === "mock" ||
        property.value === "unstable_mockModule")
      ? property.value
      : null
    : property.type === "Identifier"
      ? property.name
      : null;
  return method !== null && moduleMockMethods.has(method);
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
