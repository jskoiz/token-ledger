

const BUILT_INS = new Set([
	"Record",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"PropertyKey",
	"NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);






























function declaredStatement(statement                  )                     {
	return statement.type === "ExportNamedDeclaration" ||
		statement.type === "ExportDefaultDeclaration"
		? (statement.declaration ?? null)
		: statement;
}

export function createTypeEnvironment(program                )                  {
	const aliases = new Map                                       ();
	const interfaces = new Map                                         ();
	const shadowedBuiltIns = new Set        ();

	for (const statement of program.body) {
		const declaration = declaredStatement(statement);
		if (declaration?.type === "ImportDeclaration") {
			for (const specifier of declaration.specifiers) {
				if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name);
			}
			continue;
		}

		if (declaration?.type === "TSTypeAliasDeclaration") {
			const existing = aliases.get(declaration.id.name);
			if (existing === undefined) aliases.set(declaration.id.name, declaration);
			else shadowedBuiltIns.add(declaration.id.name);
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
			continue;
		}

		if (declaration?.type === "TSInterfaceDeclaration") {
			const declarations = interfaces.get(declaration.id.name) ?? [];
			declarations.push(declaration);
			interfaces.set(declaration.id.name, declarations);
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
			continue;
		}

		if (declaration?.type === "TSEnumDeclaration") {
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
			continue;
		}

		if (declaration?.type === "ClassDeclaration" && declaration.id !== null) {
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
		}
	}

	return { aliases, interfaces, shadowedBuiltIns };
}

function typeNameNode(type) {
	if (type?.type === "TSTypeReference") return type.typeName;
	if (type?.type === "TSInterfaceHeritage") return type.expression;
	return null;
}

function typeReferenceName(type                        )                {
	const typeName = typeNameNode(type);
	if (typeName?.type === "Identifier") return typeName.name;
	if (typeName?.type === "TSQualifiedName") return typeName.right.name;
	if (
		(typeName?.type === "StaticMemberExpression" || typeName?.type === "MemberExpression") &&
		typeName.computed !== true &&
		typeName.property?.type === "Identifier"
	)
		return typeName.property.name;
	return null;
}

function isBuiltIn(name        , environment                 )          {
	return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);
}

function typeBinding(type               , environment                 )                     {
	if (environment.resolveTypeBinding !== undefined) {
		return environment.resolveTypeBinding(type);
	}
	if (typeNameNode(type)?.type !== "Identifier") return undefined;
	const name = typeReferenceName(type);
	if (name === null) return undefined;
	const alias = environment.aliases.get(name);
	if (alias !== undefined) return { alias };
	const interfaces = environment.interfaces.get(name);
	return interfaces === undefined ? undefined : { interfaces };
}

function isBuiltInReference(type               , environment                 )          {
	if (typeNameNode(type)?.type !== "Identifier") return false;
	if (environment.resolveTypeBinding !== undefined && typeBinding(type, environment) !== undefined)
		return false;
	const name = typeReferenceName(type);
	return name !== null && isBuiltIn(name, environment);
}

function aliasFor(type               , environment                 )                     {
	const binding = typeBinding(type, environment);
	if (binding !== undefined) return binding.alias;
	if (environment.resolveTypeBinding !== undefined) return undefined;
	if (typeNameNode(type)?.type !== "Identifier") return undefined;
	const name = typeReferenceName(type);
	return name === null ? undefined : environment.aliases.get(name);
}

function interfacesFor(type               , environment                 )                     {
	const binding = typeBinding(type, environment);
	if (binding !== undefined) return binding.interfaces;
	if (environment.resolveTypeBinding !== undefined) return undefined;
	if (typeNameNode(type)?.type !== "Identifier") return undefined;
	const name = typeReferenceName(type);
	return name === null ? undefined : environment.interfaces.get(name);
}

function isUnappliedReferenceTo(type               , name        )          {
	const unwrapped = unwrapTransparentType(type);
	return (
		unwrapped.type === "TSTypeReference" &&
		typeNameNode(unwrapped)?.type === "Identifier" &&
		typeReferenceName(unwrapped) === name &&
		(unwrapped.typeArguments === null ||
			unwrapped.typeArguments === undefined ||
			unwrapped.typeArguments.params.length === 0)
	);
}

function substitutionFor(
	type               ,
	name        ,
	substitutions                      ,
)                {
	return typeNameNode(type)?.type === "Identifier" ? substitutions.get(name) : undefined;
}

function unwrapTransparentType(type               )                {
	let current = type;
	while (
		current.type === "TSParenthesizedType" ||
		(current.type === "TSTypeOperator" && current.operator === "readonly")
	) {
		current = current.typeAnnotation;
	}
	return current;
}

function isNeverType(type               )          {
	return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member                    )          {
	return (
		member.type === "TSPropertySignature" &&
		member.optional === true &&
		member.typeAnnotation !== null &&
		member.typeAnnotation !== undefined &&
		isNeverType(member.typeAnnotation.typeAnnotation)
	);
}

function isEffectivelyEmptyTypeLiteral(type                      )          {
	return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
	declarations                                          ,
)          {
	return declarations.length > 0 && declarations.every(
		(type) =>
			type.extends.length === 0 &&
			(type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember)),
	);
}

function resolvedSubstitutionArgument(
	type               ,
	base                      ,
	resolving                      = new Set(),
)                {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type !== "TSTypeReference" || unwrapped.typeName.type !== "Identifier") return type;
	const name = typeReferenceName(unwrapped);
	if (name === null || resolving.has(name)) return type;
	const substitution = base.get(name);
	if (substitution === undefined) return type;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return resolvedSubstitutionArgument(substitution, base, nextResolving);
}

function aliasSubstitution(
	alias                               ,
	type                        ,
	base                      ,
)                              {
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	const next = new Map(base);
	for (const [index, parameter] of parameters.entries()) {
		const argument = arguments_[index] ?? parameter.default;
		if (argument === null || argument === undefined) return null;
		next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next));
	}
	return next;
}

function interfaceIndexEntries(
	type               ,
	_environment                 ,
	substitutions                      ,
	resolvingInterfaces                     = new Set(),
)                          {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type !== "TSTypeReference" && unwrapped.type !== "TSInterfaceHeritage") return [];
	const declarations = interfacesFor(unwrapped, _environment);
	if (declarations === undefined) return [];
	const entries = [];
	for (const declaration of declarations) {
		if (resolvingInterfaces.has(declaration)) continue;
		const nextSubstitutions = aliasSubstitution(declaration, unwrapped, substitutions);
		if (nextSubstitutions === null) continue;
		const nextResolving = new Set(resolvingInterfaces);
		nextResolving.add(declaration);
		for (const member of declaration.body.body) {
			if (member.type !== "TSIndexSignature" || member.typeAnnotation === null) continue;
			const parameter = member.parameters[0];
			entries.push({
				key: parameter?.typeAnnotation?.typeAnnotation ?? null,
				value: member.typeAnnotation.typeAnnotation,
				substitutions: nextSubstitutions,
			});
		}
		for (const extended of declaration.extends ?? []) {
			entries.push(
				...interfaceIndexEntries(
					extended,
					_environment,
					nextSubstitutions,
					nextResolving,
				),
			);
		}
	}
	return entries;
}

function unsafeDirectValue(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     ,
)                                         {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return "unknown";
	if (unwrapped.type === "TSAnyKeyword") return "any";
	if (unwrapped.type === "TSObjectKeyword") return "object";
	if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
		return "empty-object";
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.some(
			(member) => unsafeDirectValue(member, environment, substitutions, resolvingAliases) !== null,
		)
			? "union"
			: null;
	}
	if (unwrapped.type === "TSIntersectionType") {
		const unsafeMembers = unwrapped.types.map((member) =>
			unsafeDirectValue(member, environment, substitutions, resolvingAliases),
		);
		if (unsafeMembers.includes("any")) return "any";
		return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
			? unsafeMembers[0]
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInReference(unwrapped, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: unsafeDirectValue(wrapped, environment, substitutions, resolvingAliases);
	}
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? null
			: unsafeDirectValue(substitution, environment, substitutions, resolvingAliases);
	}
	const interfaceDeclarations = interfacesFor(unwrapped, environment);
	if (interfaceDeclarations !== undefined) {
		return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null;
	}
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return unsafeDirectValue(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

function isBroadKeyofOperand(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases = new Set(),
)          {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSAnyKeyword") return true;
	if (unwrapped.type === "TSNeverKeyword") return true;
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature");
	}
	if (unwrapped.type === "TSMappedType") {
		return isBroadMappedKey(unwrapped.constraint, environment, substitutions);
	}
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.every((member) =>
			isBroadKeyofOperand(member, environment, substitutions, resolvingAliases),
		);
	}
	if (unwrapped.type === "TSIntersectionType") {
		return unwrapped.types.some((member) =>
			isBroadKeyofOperand(member, environment, substitutions, resolvingAliases),
		);
	}
	if (unwrapped.type !== "TSTypeReference") return false;
	const name = typeReferenceName(unwrapped);
	if (name === null) return false;
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? false
			: isBroadKeyofOperand(
				substitution,
				environment,
				substitutions,
				resolvingAliases,
			);
	}
	if (name === "Record" && isBuiltInReference(unwrapped, environment)) {
		const key = unwrapped.typeArguments?.params[0];
		return key !== undefined && isBroadMappedKey(key, environment, substitutions);
	}
	const inheritedIndexEntries = interfaceIndexEntries(
		unwrapped,
		environment,
		substitutions,
		resolvingAliases,
	);
	if (inheritedIndexEntries.length > 0) {
		return inheritedIndexEntries.some((entry) =>
			entry.key !== null && isBroadMappedKey(entry.key, environment, entry.substitutions),
		);
	}
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return false;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return false;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return isBroadKeyofOperand(
		alias.typeAnnotation,
		environment,
		nextSubstitutions,
		nextResolving,
	);
}

function isBroadPickKey(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases = new Set(),
)          {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type === "TSStringKeyword" ||
		unwrapped.type === "TSNumberKeyword" ||
		unwrapped.type === "TSSymbolKeyword" ||
		unwrapped.type === "TSAnyKeyword" ||
		unwrapped.type === "TSUnknownKeyword"
	)
		return true;
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.some((member) =>
			isBroadPickKey(member, environment, substitutions, resolvingAliases),
		);
	}
	if (unwrapped.type === "TSTemplateLiteralType") {
		return isBroadMappedKey(unwrapped, environment, substitutions);
	}
	if (unwrapped.type === "TSTypeOperator" && unwrapped.operator === "keyof")
		return isBroadKeyofOperand(unwrapped.typeAnnotation, environment, substitutions);
	if (unwrapped.type !== "TSTypeReference") return false;
	const name = typeReferenceName(unwrapped);
	if (name === null) return false;
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? false
			: isBroadPickKey(substitution, environment, substitutions, resolvingAliases);
	}
	if (name === "PropertyKey" && isBuiltInReference(unwrapped, environment)) return true;
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return false;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return false;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return isBroadPickKey(
		alias.typeAnnotation,
		environment,
		nextSubstitutions,
		nextResolving,
	);
}

export function isFinitePickType(type               , environment                 )          {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type !== "TSTypeReference" ||
		typeReferenceName(unwrapped) !== "Pick" ||
		!isBuiltInReference(unwrapped, environment)
	)
		return false;
	const keys = unwrapped.typeArguments?.params[1];
	return keys !== undefined && !isBroadPickKey(keys, environment, new Map());
}

export function isFinitePickSourceType(
	type               ,
	pick               ,
	environment                 ,
)          {
	if (!isFinitePickType(pick, environment)) return false;
	const source = pick.typeArguments?.params[0];
	return source !== undefined && unwrapTransparentType(type) === unwrapTransparentType(source);
}

export function isClosedOmitType(type               , environment                 )          {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type !== "TSTypeReference" ||
		typeReferenceName(unwrapped) !== "Omit" ||
		!isBuiltInReference(unwrapped, environment)
	)
		return false;
	const source = unwrapped.typeArguments?.params[0];
	const keys = unwrapped.typeArguments?.params[1];
	if (source === undefined || keys === undefined) return false;
	const sourceDomains = keyDomainsForContainer(source, environment, new Map());
	return sourceDomains !== null && sourceDomains.size > 0 &&
		!isOmitDictionaryOpen(source, keys, environment, new Map());
}

export function isClosedOmitSourceType(
	type               ,
	omit               ,
	environment                 ,
)          {
	if (!isClosedOmitType(omit, environment)) return false;
	const source = omit.typeArguments?.params[0];
	return source !== undefined && unwrapTransparentType(type) === unwrapTransparentType(source);
}

function propertyKeyName(node) {
	if (node?.type === "Identifier") return node.name;
	if (node?.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
		return String(node.value);
	return null;
}

function finiteKeyNames(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     = new Set(),
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSNeverKeyword") return new Set();
	if (unwrapped.type === "TSLiteralType") {
		const name = propertyKeyName(unwrapped.literal);
		return name === null ? null : new Set([name]);
	}
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.reduce((names, member) => {
			const memberNames = finiteKeyNames(member, environment, substitutions, resolvingAliases);
			return memberNames === null ? null : new Set([...names, ...memberNames]);
		}, new Set());
	}
	if (unwrapped.type === "TSTemplateLiteralType") {
		let names = new Set([""]);
		for (const [index, part] of (unwrapped.types ?? []).entries()) {
			const partNames = finiteKeyNames(part, environment, substitutions, resolvingAliases);
			if (partNames === null) return null;
			if (partNames.size === 0) return new Set();
			const prefix = unwrapped.quasis?.[index]?.value?.raw ?? "";
			const next = new Set();
			for (const name of names) {
				for (const partName of partNames) {
					next.add(`${name}${prefix}${partName}`);
					if (next.size > 256) return null;
				}
			}
			names = next;
		}
		const suffix = unwrapped.quasis?.[(unwrapped.types ?? []).length]?.value?.raw ?? "";
		return new Set([...names].map((name) => `${name}${suffix}`));
	}
	if (unwrapped.type === "TSTypeOperator" && unwrapped.operator === "keyof") {
		return finitePropertyKeysForType(unwrapped.typeAnnotation, environment, substitutions);
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined && !isUnappliedReferenceTo(substitution, name)) {
		return finiteKeyNames(substitution, environment, substitutions, resolvingAliases);
	}
	if (name === "PropertyKey" && isBuiltInReference(unwrapped, environment)) return null;
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return finiteKeyNames(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

function finiteInterfacePropertyKeys(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingInterfaces                     = new Set(),
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type !== "TSTypeReference") return null;
	const declarations = interfacesFor(unwrapped, environment);
	if (declarations === undefined) return null;
	let names = new Set();
	for (const declaration of declarations) {
		if (resolvingInterfaces.has(declaration)) return null;
		const nextSubstitutions = aliasSubstitution(declaration, unwrapped, substitutions);
		if (nextSubstitutions === null) return null;
		const nextResolving = new Set(resolvingInterfaces);
		nextResolving.add(declaration);
		for (const member of declaration.body.body) {
			if (member.type === "TSIndexSignature") return null;
			if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
			const name = propertyKeyName(member.key);
			if (name === null) return null;
			names.add(name);
		}
		for (const extended of declaration.extends ?? []) {
			const extendedNames = finiteInterfacePropertyKeys(
				extended,
				environment,
				nextSubstitutions,
				nextResolving,
			);
			if (extendedNames === null) return null;
			names = new Set([...names, ...extendedNames]);
		}
	}
	return names;
}

function finitePropertyKeysForType(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     = new Set(),
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSTypeLiteral") {
		const names = new Set();
		for (const member of unwrapped.members) {
			if (member.type === "TSIndexSignature") return null;
			if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
			const name = propertyKeyName(member.key);
			if (name === null) return null;
			names.add(name);
		}
		return names;
	}
	if (unwrapped.type === "TSMappedType") {
		return unwrapped.constraint === null || unwrapped.constraint === undefined
			? null
			: finiteKeyNames(unwrapped.constraint, environment, substitutions, resolvingAliases);
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined && !isUnappliedReferenceTo(substitution, name)) {
		return finitePropertyKeysForType(substitution, environment, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltInReference(unwrapped, environment)) {
		const key = unwrapped.typeArguments?.params[0];
		return key === undefined ? null : finiteKeyNames(key, environment, substitutions, resolvingAliases);
	}
	if (name === "Pick" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		if (source === undefined || keys === undefined) return null;
		const sourceNames = finitePropertyKeysForType(source, environment, substitutions, resolvingAliases);
		const pickedNames = finiteKeyNames(keys, environment, substitutions, resolvingAliases);
		if (sourceNames === null || pickedNames === null) return null;
		return new Set([...sourceNames].filter((key) => pickedNames.has(key)));
	}
	if (name === "Omit" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		if (source === undefined || keys === undefined) return null;
		const sourceNames = finitePropertyKeysForType(source, environment, substitutions, resolvingAliases);
		const omittedNames = finiteKeyNames(keys, environment, substitutions, resolvingAliases);
		if (sourceNames === null || omittedNames === null) return null;
		return new Set([...sourceNames].filter((key) => !omittedNames.has(key)));
	}
	const interfaceNames = finiteInterfacePropertyKeys(unwrapped, environment, substitutions);
	if (interfaceNames !== null) return interfaceNames;
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return finitePropertyKeysForType(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

function finiteSourceValueContext(node, source) {
	let current = node;
	let sourceMember = null;
	while (current !== null && current !== source) {
		if (current.type === "TSPropertySignature" || current.type === "TSMethodSignature") {
			sourceMember = current;
		}
		current = current.parent;
	}
	if (current !== source) return null;
	if (sourceMember !== null) {
		const name = propertyKeyName(sourceMember.key);
		return name === null ? null : { propertyKey: name };
	}
	const unwrapped = unwrapTransparentType(source);
	if (unwrapped.type === "TSMappedType" && unwrapped.typeAnnotation !== null &&
		isNodeWithin(node, unwrapped.typeAnnotation))
		return { shared: true };
	if (unwrapped.type === "TSTypeReference") {
		const value = unwrapped.typeArguments?.params[1];
		if (value !== undefined && isNodeWithin(node, value)) return { shared: true };
	}
	return null;
}

function isNodeWithin(node, ancestor) {
	let current = node;
	while (current !== null) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

export function isFilteredFiniteContainerValueType(node               , container               , environment                 )          {
	const unwrapped = unwrapTransparentType(container);
	if (
		unwrapped.type !== "TSTypeReference" ||
		(typeReferenceName(unwrapped) !== "Pick" && typeReferenceName(unwrapped) !== "Omit") ||
		!isBuiltInReference(unwrapped, environment)
	)
		return false;
	const source = unwrapped.typeArguments?.params[0];
	const keys = unwrapped.typeArguments?.params[1];
	if (source === undefined || keys === undefined) return false;
	const operationKeys = finiteKeyNames(keys, environment, new Map());
	if (operationKeys === null) return false;
	const context = finiteSourceValueContext(node, source);
	if (context === null) return false;
	const name = typeReferenceName(unwrapped);
	if (context.propertyKey !== undefined) {
		return name === "Pick"
			? !operationKeys.has(context.propertyKey)
			: operationKeys.has(context.propertyKey);
	}
	if (context.shared !== true) return false;
	const sourceKeys = finitePropertyKeysForType(source, environment, new Map());
	if (sourceKeys === null || sourceKeys.size === 0) return false;
	return name === "Pick"
		? ![...sourceKeys].some((key) => operationKeys.has(key))
		: [...sourceKeys].every((key) => operationKeys.has(key));
}

function dictionaryValueTypes(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     ,
)                          {
	const unwrapped = unwrapTransparentType(type);

	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.flatMap((member)                          =>
			member.type === "TSIndexSignature" && member.typeAnnotation !== null
				? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
				: [],
		);
	}

	if (unwrapped.type === "TSMappedType") {
		return unwrapped.typeAnnotation === null ||
			unwrapped.constraint === null ||
			unwrapped.constraint === undefined ||
			!isBroadMappedKey(unwrapped.constraint, environment, substitutions)
			? []
			: [{ type: unwrapped.typeAnnotation, substitutions }];
	}

	if (unwrapped.type !== "TSTypeReference") return [];
	const name = typeReferenceName(unwrapped);
	if (name === null) return [];

	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? []
			: dictionaryValueTypes(substitution, environment, substitutions, resolvingAliases);
	}

	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInReference(unwrapped, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? []
			: dictionaryValueTypes(wrapped, environment, substitutions, resolvingAliases);
	}

	if (name === "Record" && isBuiltInReference(unwrapped, environment)) {
		const key = unwrapped.typeArguments?.params[0];
		const value = unwrapped.typeArguments?.params[1] ?? null;
		return key === undefined || !isBroadMappedKey(key, environment, substitutions) || value === null
			? []
			: [{ type: value, substitutions }];
	}

	if (name === "Pick" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		return source === undefined || keys === undefined ||
			!isBroadPickKey(keys, environment, substitutions)
			? []
			: dictionaryValueTypes(source, environment, substitutions, resolvingAliases);
	}

	if (name === "Omit" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		return source === undefined || keys === undefined ||
			!isOmitDictionaryOpen(source, keys, environment, substitutions)
			? []
			: dictionaryValueTypes(source, environment, substitutions, resolvingAliases);
	}

	const inheritedIndexEntries = interfaceIndexEntries(
		unwrapped,
		environment,
		substitutions,
		new Set(),
	);
	if (inheritedIndexEntries.length > 0) {
		return inheritedIndexEntries.map((entry) => ({
			type: entry.value,
			substitutions: entry.substitutions,
		}));
	}

	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return [];
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return [];
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return dictionaryValueTypes(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

export function classifyUnsafeDictionaryValue(
	valueType               ,
	environment                 ,
)                          {
	const unsafeValue = unsafeDirectValue(valueType, environment, new Map(), new Set());
	return unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue };
}

export function classifyUnsafeDictionary(
	type               ,
	environment                 ,
)                          {
	for (const valueType of dictionaryValueTypes(type, environment, new Map(), new Set())) {
		const unsafeValue = unsafeDirectValue(
			valueType.type,
			environment,
			valueType.substitutions,
			new Set(),
		);
		if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
	}
	return null;
}

function resolvesToDictionary(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     ,
)          {
	return dictionaryValueTypes(type, environment, substitutions, resolvingAliases).length > 0;
}

export function classifyWideningTarget(
	type               ,
	environment                 ,
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSAnyKeyword") return { kind: "any" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: unwrapped.members.length > 0
				? { kind: "anonymous object" }
				: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return unwrapped.constraint !== null &&
			unwrapped.constraint !== undefined &&
			isBroadMappedKey(unwrapped.constraint, environment, new Map())
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInReference(unwrapped, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined ? null : classifyWideningTarget(wrapped, environment);
	}
	if (name === "Record" && isBuiltInReference(unwrapped, environment)) {
		const key = unwrapped.typeArguments?.params[0];
		return key !== undefined && isBroadMappedKey(key, environment, new Map())
			? { kind: "open dictionary" }
			: null;
	}
	if (name === "Pick" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		return source === undefined || keys === undefined ||
			!isBroadPickKey(keys, environment, new Map())
			? null
			: classifyWideningTarget(source, environment);
	}
	if (name === "Omit" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		const sourceTarget = source === undefined
			? null
			: classifyWideningTarget(source, environment);
		return sourceTarget?.kind === "open dictionary" &&
			keys !== undefined &&
			isOmitDictionaryOpen(source, keys, environment, new Map())
			? sourceTarget
			: null;
	}
	if (interfaceIndexEntries(unwrapped, environment, new Map()).length > 0) {
		return { kind: "open dictionary" };
	}
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined) return null;
	if ((alias.typeParameters?.params.length ?? 0) > 0) {
		const substitutions = aliasSubstitution(alias, unwrapped, new Map());
		return substitutions !== null &&
			resolvesToDictionary(alias.typeAnnotation, environment, substitutions, new Set([alias]))
			? { kind: "generic container" }
			: null;
	}
	const substitutions = aliasSubstitution(alias, unwrapped, new Map());
	if (substitutions === null) return null;
	const resolved = classifyAliasBroadTarget(
		alias.typeAnnotation,
		environment,
		substitutions,
		new Set([alias]),
	);
	return resolved;
}

function isBroadMappedKey(
	type               ,
	environment                 ,
	substitutions                      ,
)          {
	const domains = keyDomainsForKey(type, environment, substitutions);
	return domains !== null && domains.size > 0;
}

const ALL_KEY_DOMAINS = new Set(["string", "number", "symbol"]);

function unionKeyDomains(left, right) {
	if (left === null || right === null) return null;
	return new Set([...left, ...right]);
}

function intersectKeyDomains(left, right) {
	if (left === null || right === null) return null;
	return new Set([...left].filter((domain) => right.has(domain)));
}

function keyDomainsForKeyofOperand(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     = new Set(),
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.reduce(
			(domains, member) => intersectKeyDomains(
				domains,
				keyDomainsForKeyofOperand(member, environment, substitutions, resolvingAliases),
			),
			ALL_KEY_DOMAINS,
		);
	}
	if (unwrapped.type === "TSIntersectionType") {
		return unwrapped.types.reduce(
			(domains, member) => unionKeyDomains(
				domains,
				keyDomainsForKeyofOperand(member, environment, substitutions, resolvingAliases),
			),
			new Set(),
		);
	}
	if (unwrapped.type === "TSAnyKeyword") return new Set(ALL_KEY_DOMAINS);
	if (unwrapped.type === "TSNeverKeyword") return new Set(ALL_KEY_DOMAINS);
	return keyDomainsForContainer(unwrapped, environment, substitutions, resolvingAliases);
}

function keyDomainsForKey(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     = new Set(),
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSStringKeyword") return new Set(["string"]);
	if (unwrapped.type === "TSNumberKeyword") return new Set(["number"]);
	if (unwrapped.type === "TSSymbolKeyword") return new Set(["symbol"]);
	if (unwrapped.type === "TSAnyKeyword") return new Set(ALL_KEY_DOMAINS);
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.reduce(
			(domains, member) => unionKeyDomains(
				domains,
				keyDomainsForKey(member, environment, substitutions, resolvingAliases),
			),
			new Set(),
		);
	}
	if (unwrapped.type === "TSTemplateLiteralType") {
		return unwrapped.types.some((part) =>
			keyDomainsForKey(part, environment, substitutions, resolvingAliases)?.size > 0,
		)
			? new Set(["string"])
			: new Set();
	}
	if (unwrapped.type === "TSTypeOperator" && unwrapped.operator === "keyof") {
		return keyDomainsForKeyofOperand(unwrapped.typeAnnotation, environment, substitutions, resolvingAliases);
	}
	if (unwrapped.type !== "TSTypeReference") return new Set();
	const name = typeReferenceName(unwrapped);
	if (name === null) return new Set();
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined && !isUnappliedReferenceTo(substitution, name)) {
		return keyDomainsForKey(substitution, environment, substitutions, resolvingAliases);
	}
	if (name === "PropertyKey" && isBuiltInReference(unwrapped, environment)) {
		return new Set(ALL_KEY_DOMAINS);
	}
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return keyDomainsForKey(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

function keyDomainsForContainer(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     = new Set(),
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.reduce((domains, member) => {
			if (member.type !== "TSIndexSignature") return domains;
			const parameter = member.parameters[0];
			const key = parameter?.typeAnnotation?.typeAnnotation;
			return unionKeyDomains(
				domains,
				key === undefined ? new Set(ALL_KEY_DOMAINS) :
					keyDomainsForKey(key, environment, substitutions, resolvingAliases),
			);
		}, new Set());
	}
	if (unwrapped.type === "TSMappedType") {
		return unwrapped.constraint === null || unwrapped.constraint === undefined
			? null
			: keyDomainsForKey(unwrapped.constraint, environment, substitutions, resolvingAliases);
	}
	if (unwrapped.type !== "TSTypeReference") return new Set();
	const name = typeReferenceName(unwrapped);
	if (name === null) return new Set();
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined && !isUnappliedReferenceTo(substitution, name)) {
		return keyDomainsForContainer(substitution, environment, substitutions, resolvingAliases);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInReference(unwrapped, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: keyDomainsForContainer(wrapped, environment, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltInReference(unwrapped, environment)) {
		const key = unwrapped.typeArguments?.params[0];
		return key === undefined
			? null
			: keyDomainsForKey(key, environment, substitutions, resolvingAliases);
	}
	if (name === "Pick" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		if (source === undefined || keys === undefined) return null;
		const sourceDomains = keyDomainsForContainer(source, environment, substitutions, resolvingAliases);
		const keyDomains = keyDomainsForKey(keys, environment, substitutions, resolvingAliases);
		return intersectKeyDomains(sourceDomains, keyDomains);
	}
	if (name === "Omit" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		if (source === undefined || keys === undefined) return null;
		const sourceDomains = keyDomainsForContainer(source, environment, substitutions, resolvingAliases);
		const omittedDomains = keyDomainsForKey(keys, environment, substitutions, resolvingAliases);
		if (sourceDomains === null || omittedDomains === null) return null;
		return new Set([...sourceDomains].filter((domain) => !omittedDomains.has(domain)));
	}
	const inheritedIndexEntries = interfaceIndexEntries(
		unwrapped,
		environment,
		substitutions,
		resolvingAliases,
	);
	if (inheritedIndexEntries.length > 0) {
		return inheritedIndexEntries.reduce((domains, entry) =>
			unionKeyDomains(
				domains,
				entry.key === null
					? new Set(ALL_KEY_DOMAINS)
					: keyDomainsForKey(entry.key, environment, entry.substitutions, resolvingAliases),
			), new Set());
	}
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return keyDomainsForContainer(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

function isOmitDictionaryOpen(
	source               ,
	keys               ,
	environment                 ,
	substitutions                      ,
)          {
	const sourceDomains = keyDomainsForContainer(source, environment, substitutions);
	const omittedDomains = keyDomainsForKey(keys, environment, substitutions);
	if (sourceDomains === null || omittedDomains === null) return true;
	return [...sourceDomains].some((domain) => !omittedDomains.has(domain));
}

function classifyAliasBroadTarget(
	type               ,
	environment                 ,
	substitutions                      ,
	resolvingAliases                     ,
)                        {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSAnyKeyword") return { kind: "any" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return unwrapped.constraint !== null &&
			unwrapped.constraint !== undefined &&
			isBroadMappedKey(unwrapped.constraint, environment, substitutions)
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutionFor(unwrapped, name, substitutions);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? null
			: classifyAliasBroadTarget(
					substitution,
					environment,
					substitutions,
					resolvingAliases,
				);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInReference(unwrapped, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyAliasBroadTarget(wrapped, environment, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltInReference(unwrapped, environment)) {
		const key = unwrapped.typeArguments?.params[0];
		return key !== undefined && isBroadMappedKey(key, environment, substitutions)
			? { kind: "open dictionary" }
			: null;
	}
	if (name === "Pick" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		return source === undefined || keys === undefined ||
			!isBroadPickKey(keys, environment, substitutions)
			? null
			: classifyAliasBroadTarget(source, environment, substitutions, resolvingAliases);
	}
	if (name === "Omit" && isBuiltInReference(unwrapped, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		const keys = unwrapped.typeArguments?.params[1];
		const sourceTarget = source === undefined
			? null
			: classifyAliasBroadTarget(source, environment, substitutions, resolvingAliases);
		return sourceTarget?.kind === "open dictionary" &&
			keys !== undefined &&
			isOmitDictionaryOpen(source, keys, environment, substitutions)
			? sourceTarget
			: null;
	}
	if (interfaceIndexEntries(unwrapped, environment, substitutions).length > 0) {
		return { kind: "open dictionary" };
	}
	const alias = aliasFor(unwrapped, environment);
	if (alias === undefined || resolvingAliases.has(alias)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return classifyAliasBroadTarget(
		alias.typeAnnotation,
		environment,
		nextSubstitutions,
		nextResolving,
	);
}

export function isPopulatedObjectExpression(expression                   )          {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current.type === "ObjectExpression" && current.properties.length > 0;
}

export function isKnownEvidenceExpression(expression                   )          {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression" ||
		current.type === "TSSatisfiesExpression"
	) {
		current = current.expression;
	}
	if (current.type === "ObjectExpression") return true;
	return (
		current.type === "ArrayExpression" ||
		current.type === "ArrowFunctionExpression" ||
		current.type === "ClassExpression" ||
		current.type === "FunctionExpression" ||
		current.type === "NewExpression" ||
		current.type === "Literal" ||
		current.type === "TemplateLiteral" ||
		current.type === "UnaryExpression"
	);
}
