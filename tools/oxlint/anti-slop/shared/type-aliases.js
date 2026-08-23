const namespaceAliasIndexes = new WeakMap();

function qualifiedNameParts(name) {
  if (name.type === "Identifier") return [name.name];
  if (name.type !== "TSQualifiedName") return null;
  const left = qualifiedNameParts(name.left);
  return left === null ? null : [...left, name.right.name];
}

/** Return a simple or namespace-qualified reference and its type arguments. */
export function typeAliasReference(type) {
  if (type.type === "TSParenthesizedType") {
    return typeAliasReference(type.typeAnnotation);
  }
  if (type.type !== "TSTypeReference") return null;
  const parts = qualifiedNameParts(type.typeName);
  if (parts === null || parts.length === 0) return null;
  return {
    name: parts.at(-1),
    namespace: parts.slice(0, -1),
    arguments: type.typeArguments?.params ?? [],
  };
}

function addNamespaceAlias(index, namespacePath, alias) {
  const key = [...namespacePath, alias.id.name].join(".");
  if (!index.has(key)) index.set(key, alias);
}

function collectModuleAliases(index, module, namespacePath) {
  if (module.id.type !== "Identifier") return;
  const path = [...namespacePath, module.id.name];
  const body = module.body;
  if (body === null || body === undefined) return;
  if (body.type === "TSModuleDeclaration") {
    collectModuleAliases(index, body, path);
    return;
  }
  if (body.type !== "TSModuleBlock") return;

  for (const statement of body.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === "TSModuleDeclaration") {
      collectModuleAliases(index, declaration, path);
      continue;
    }
    if (exported && declaration?.type === "TSTypeAliasDeclaration") {
      addNamespaceAlias(index, path, declaration);
    }
  }
}

function namespaceAliasIndex(sourceCode) {
  const cached = namespaceAliasIndexes.get(sourceCode);
  if (cached !== undefined) return cached;
  const index = new Map();
  for (const statement of sourceCode.ast.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "TSModuleDeclaration") {
      collectModuleAliases(index, declaration, []);
    }
  }
  namespaceAliasIndexes.set(sourceCode, index);
  return index;
}

function containingNamespacePath(node) {
  const path = [];
  let current = node.parent;
  while (current !== null) {
    if (current.type === "TSModuleDeclaration" && current.id.type === "Identifier") {
      path.unshift(current.id.name);
    }
    current = current.parent;
  }
  return path;
}

function namespaceAlias(reference, referenceNode, sourceCode) {
  const namespacePath = reference.namespace.length > 0
    ? reference.namespace
    : containingNamespacePath(referenceNode);
  if (namespacePath.length === 0) return null;
  const alias = namespaceAliasIndex(sourceCode).get(
    [...namespacePath, reference.name].join("."),
  );
  return alias ?? null;
}

/**
 * Resolve the visible type binding without confusing value-space shadowing
 * with type-space shadowing. A non-alias type binding is returned as a shadow.
 */
export function visibleTypeAliasBinding(reference, referenceNode, sourceCode) {
  if (reference.namespace.length > 0) {
    const alias = namespaceAlias(reference, referenceNode, sourceCode);
    return alias === null ? null : { alias };
  }

  let scope = sourceCode.getScope(referenceNode);
  while (scope !== null) {
    const variable = scope.set.get(reference.name);
    if (variable === undefined || variable.isTypeVariable !== true) {
      scope = scope.upper;
      continue;
    }
    const definition = variable.defs.find(
      (candidate) => candidate.node.type === "TSTypeAliasDeclaration",
    );
    if (definition !== undefined) return { alias: definition.node };
    if (variable.defs.length > 0) return { alias: null };
    scope = scope.upper;
  }

  const alias = namespaceAlias(reference, referenceNode, sourceCode);
  return alias === null ? null : { alias };
}

/** Resolve a visible type alias, returning null for absent or shadowed names. */
export function visibleTypeAlias(reference, referenceNode, sourceCode) {
  return visibleTypeAliasBinding(reference, referenceNode, sourceCode)?.alias ?? null;
}
