import { defineRule } from "@oxlint/plugins";

import {
	classifyUnsafeDictionary,
	classifyUnsafeDictionaryValue,
	createTypeEnvironment,
	isClosedOmitSourceType,
	isFilteredFiniteContainerValueType,
	isFinitePickSourceType,

} from "../shared/dictionary-types.js";
import {
	typeAliasReference,
	visibleTypeBinding,
} from "../shared/type-aliases.js";



const typeNodeKinds                      = new Set([
	"JSDocNonNullableType",
	"JSDocNullableType",
	"JSDocUnknownType",
	"TSAnyKeyword",
	"TSArrayType",
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSConditionalType",
	"TSConstructorType",
	"TSFunctionType",
	"TSImportType",
	"TSIndexedAccessType",
	"TSInferType",
	"TSIntersectionType",
	"TSIntrinsicKeyword",
	"TSLiteralType",
	"TSMappedType",
	"TSNamedTupleMember",
	"TSNeverKeyword",
	"TSNullKeyword",
	"TSNumberKeyword",
	"TSObjectKeyword",
	"TSParenthesizedType",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSTemplateLiteralType",
	"TSThisType",
	"TSTupleType",
	"TSTypeLiteral",
	"TSTypeOperator",
	"TSTypePredicate",
	"TSTypeQuery",
	"TSTypeReference",
	"TSUndefinedKeyword",
	"TSUnionType",
	"TSUnknownKeyword",
	"TSVoidKeyword",
]);

function isTypeNode(node             )                        {
	return typeNodeKinds.has(node.type);
}

function aliasFromType(type               , environment                 )          {
	const binding = environment.resolveTypeBinding?.(type);
	if (binding !== undefined) return binding.alias ?? null;
	if (typeAliasReference(type)?.namespace.length > 0) return null;
	const name = type.typeName?.type === "Identifier" ? type.typeName.name : null;
	return name === null ? null : environment.aliases.get(name) ?? null;
}

function isInsideTypeAliasDeclaration(node             )          {
	let current                     = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "TSTypeAliasDeclaration") return true;
		current = current.parent;
	}
	return false;
}

function hasReportableType(node               , environment                 )          {
	if (node === null || typeof node !== "object") return false;
	if (
		typeNodeKinds.has(node.type) &&
		classifyUnsafeDictionary(node, environment) !== null
	)
		return true;
	if (
		node.type === "TSIndexSignature" &&
		node.typeAnnotation !== null &&
		node.parent?.type !== "TSTypeLiteral" &&
		classifyUnsafeDictionaryValue(
			node.typeAnnotation.typeAnnotation,
			environment,
		) !== null
	)
		return true;

	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) {
			if (value.some((child) => hasReportableType(child, environment))) return true;
			continue;
		}
		if (hasReportableType(value, environment)) return true;
	}
	return false;
}

function isPlainAliasConsumerUse(node               , environment                 )          {
	if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
	const alias = aliasFromType(node, environment);
	return (
		alias !== null &&
		!isInsideTypeAliasDeclaration(node) &&
		hasReportableType(alias, environment)
	);
}

function shouldReportType(node               , environment                 )          {
	if (isPlainAliasConsumerUse(node, environment)) return false;
	if (classifyUnsafeDictionary(node, environment) === null) return false;
	let current                     = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isTypeNode(current)) {
				if (isFilteredFiniteContainerValueType(node, current, environment) ||
					isFinitePickSourceType(node, current, environment) ||
					isClosedOmitSourceType(node, current, environment))
				return false;
			if (classifyUnsafeDictionary(current, environment) !== null) return false;
		}
		current = current.parent;
	}
	return true;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryTypeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
		},
		messages: {
			unsafeDictionary:
				"This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
		},
	},
	createOnce(context) {
		let environment                         = null;
		const report = (node             , value        ) => {
			context.report({ node, messageId: "unsafeDictionary", data: { value } });
		};
		const reportIfUnsafe = (node               ) => {
			if (environment === null || !shouldReportType(node, environment)) return;
			const unsafe = classifyUnsafeDictionary(node, environment);
			if (unsafe === null) return;
			report(node, unsafe.unsafeValue);
		};

		return {
			Program(node) {
				environment = createTypeEnvironment(node);
				environment.resolveTypeBinding = (type) => {
					const reference = typeAliasReference(type);
					return reference === null
						? undefined
						: visibleTypeBinding(reference, type, context.sourceCode);
				};
			},
			TSTypeReference: reportIfUnsafe,
			TSTypeLiteral: reportIfUnsafe,
			TSMappedType: reportIfUnsafe,
			TSIndexSignature(node) {
				if (
					environment === null ||
					node.typeAnnotation === null ||
					node.parent.type === "TSTypeLiteral"
				)
					return;
				const unsafe = classifyUnsafeDictionaryValue(
					node.typeAnnotation.typeAnnotation,
					environment,
				);
				if (unsafe !== null) report(node, unsafe.unsafeValue);
			},
		};
	},
});
