const namespaceAliasIndexes = new WeakMap();
const namespaceInterfaceIndexes = new WeakMap();

function qualifiedNameParts(name) {
  if (name.type === "Identifier") return [name.name];
  if (name.type === "TSQualifiedName") {
    const left = qualifiedNameParts(name.left);
    return left === null ? null : [...left, name.right.name];
  }
  if (name.type === "StaticMemberExpression" || name.type === "MemberExpression") {
    if (name.computed === true || name.property?.type !== "Identifier") return null;
    const left = qualifiedNameParts(name.object);
    return left === null ? null : [...left, name.property.name];
  }
  return null;
}

/** Return a simple or namespace-qualified reference and its type arguments. */
export function typeAliasReference(type) {
  if (type.type === "TSParenthesizedType") {
    return typeAliasReference(type.typeAnnotation);
  }
  const name = type.type === "TSTypeReference"
    ? type.typeName
    : type.type === "TSInterfaceHeritage"
      ? type.expression
      : null;
  if (name === null) return null;
  const parts = qualifiedNameParts(name);
  if (parts === null || parts.length === 0) return null;
  return {
    name: parts.at(-1),
    namespace: parts.slice(0, -1),
    arguments: type.typeArguments?.params ?? [],
  };
}

function addNamespaceAlias(index, namespacePath, alias) {
	addNamespaceAliasNamed(index, namespacePath, alias.id.name, alias);
}

function addNamespaceAliasNamed(index, namespacePath, name, alias) {
	const key = [...namespacePath, name].join(".");
	if (!index.has(key)) index.set(key, alias);
}

function addNamespaceInterface(index, namespacePath, declaration) {
	addNamespaceInterfaceNamed(index, namespacePath, declaration.id.name, declaration);
}

function addNamespaceInterfaceNamed(index, namespacePath, name, declaration) {
	const key = [...namespacePath, name].join(".");
	const declarations = index.get(key) ?? [];
	declarations.push(declaration);
	index.set(key, declarations);
}

function exportSpecifierName(node) {
	if (node?.type === "Identifier") return node.name;
	return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
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

	const localAliases = new Map();
	for (const statement of body.body) {
		const declaration = statement.type === "ExportNamedDeclaration"
			? statement.declaration
			: statement;
		if (declaration?.type === "TSTypeAliasDeclaration") {
			localAliases.set(declaration.id.name, declaration);
		}
	}

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
		if (!exported) continue;
		for (const specifier of statement.specifiers ?? []) {
			if (specifier.type !== "ExportSpecifier") continue;
			const localName = exportSpecifierName(specifier.local);
			const exportedName = exportSpecifierName(specifier.exported);
			const alias = localName === null ? undefined : localAliases.get(localName);
			if (alias !== undefined && exportedName !== null) {
				addNamespaceAliasNamed(index, path, exportedName, alias);
			}
		}
	}
}

function collectModuleInterfaces(index, module, namespacePath) {
	if (module.id.type !== "Identifier") return;
	const path = [...namespacePath, module.id.name];
	const body = module.body;
	if (body === null || body === undefined) return;
	if (body.type === "TSModuleDeclaration") {
		collectModuleInterfaces(index, body, path);
		return;
	}
	if (body.type !== "TSModuleBlock") return;

	const localInterfaces = new Map();
	for (const statement of body.body) {
		const declaration = statement.type === "ExportNamedDeclaration"
			? statement.declaration
			: statement;
		if (declaration?.type === "TSInterfaceDeclaration") {
			const declarations = localInterfaces.get(declaration.id.name) ?? [];
			declarations.push(declaration);
			localInterfaces.set(declaration.id.name, declarations);
		}
	}

	for (const statement of body.body) {
		const exported = statement.type === "ExportNamedDeclaration";
		const declaration = exported ? statement.declaration : statement;
		if (declaration?.type === "TSModuleDeclaration") {
			collectModuleInterfaces(index, declaration, path);
			continue;
		}
		if (exported && declaration?.type === "TSInterfaceDeclaration") {
			addNamespaceInterface(index, path, declaration);
		}
		if (!exported) continue;
		for (const specifier of statement.specifiers ?? []) {
			if (specifier.type !== "ExportSpecifier") continue;
			const localName = exportSpecifierName(specifier.local);
			const exportedName = exportSpecifierName(specifier.exported);
			const declarations = localName === null ? undefined : localInterfaces.get(localName);
			if (declarations === undefined || exportedName === null) continue;
			for (const interfaceDeclaration of declarations) {
				addNamespaceInterfaceNamed(index, path, exportedName, interfaceDeclaration);
			}
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

function namespaceInterfaceIndex(sourceCode) {
	const cached = namespaceInterfaceIndexes.get(sourceCode);
	if (cached !== undefined) return cached;
	const index = new Map();
	for (const statement of sourceCode.ast.body) {
		const declaration =
			statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
		if (declaration?.type === "TSModuleDeclaration") {
			collectModuleInterfaces(index, declaration, []);
		}
	}
	namespaceInterfaceIndexes.set(sourceCode, index);
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

function namespaceEntry(index, reference, referenceNode) {
  const containingPath = containingNamespacePath(referenceNode);
  for (let depth = containingPath.length; depth >= 0; depth -= 1) {
    const key = [
      ...containingPath.slice(0, depth),
      ...reference.namespace,
      reference.name,
    ].join(".");
    const entry = index.get(key);
    if (entry !== undefined) return entry;
  }
  return null;
}

function namespaceAlias(reference, referenceNode, sourceCode) {
  return namespaceEntry(namespaceAliasIndex(sourceCode), reference, referenceNode);
}

function namespaceInterfaces(reference, referenceNode, sourceCode) {
	return namespaceEntry(namespaceInterfaceIndex(sourceCode), reference, referenceNode);
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

/** Resolve a visible interface binding, including merged namespace declarations. */
export function visibleTypeInterfaceBinding(reference, referenceNode, sourceCode) {
	if (reference.namespace.length > 0) {
		const interfaces = namespaceInterfaces(reference, referenceNode, sourceCode);
		return interfaces === null ? null : { interfaces };
	}

	let scope = sourceCode.getScope(referenceNode);
	while (scope !== null) {
		const variable = scope.set.get(reference.name);
		if (variable === undefined || variable.isTypeVariable !== true) {
			scope = scope.upper;
			continue;
		}
		const interfaces = variable.defs
			.filter((definition) => definition.node.type === "TSInterfaceDeclaration")
			.map((definition) => definition.node);
		if (interfaces.length > 0) return { interfaces };
		if (variable.defs.length > 0) return { interfaces: null };
		scope = scope.upper;
	}

	const interfaces = namespaceInterfaces(reference, referenceNode, sourceCode);
	return interfaces === null ? null : { interfaces };
}

/** Resolve the visible alias or interface binding for a type reference. */
export function visibleTypeBinding(reference, referenceNode, sourceCode) {
	if (reference.namespace.length > 0) {
		const aliasBinding = visibleTypeAliasBinding(reference, referenceNode, sourceCode);
		if (aliasBinding !== null) return { alias: aliasBinding.alias };
		const interfaceBinding = visibleTypeInterfaceBinding(reference, referenceNode, sourceCode);
		return interfaceBinding === null ? undefined : { interfaces: interfaceBinding.interfaces };
	}

	let scope = sourceCode.getScope(referenceNode);
	while (scope !== null) {
		const variable = scope.set.get(reference.name);
		if (variable === undefined || variable.isTypeVariable !== true) {
			scope = scope.upper;
			continue;
		}
		const alias = variable.defs.find(
			(definition) => definition.node.type === "TSTypeAliasDeclaration",
		);
		if (alias !== undefined) return { alias: alias.node };
		const interfaces = variable.defs
			.filter((definition) => definition.node.type === "TSInterfaceDeclaration")
			.map((definition) => definition.node);
		if (interfaces.length > 0) return { interfaces };
		if (variable.defs.length > 0) return { shadowed: true };
		scope = scope.upper;
	}

	const aliasBinding = visibleTypeAliasBinding(reference, referenceNode, sourceCode);
	if (aliasBinding !== null) return { alias: aliasBinding.alias };
	const interfaceBinding = visibleTypeInterfaceBinding(reference, referenceNode, sourceCode);
	return interfaceBinding === null ? undefined : { interfaces: interfaceBinding.interfaces };
}

/** Resolve a visible type alias, returning null for absent or shadowed names. */
export function visibleTypeAlias(reference, referenceNode, sourceCode) {
  return visibleTypeAliasBinding(reference, referenceNode, sourceCode)?.alias ?? null;
}
