import { defineRule } from "@oxlint/plugins";



import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.js";











function parameterAnnotation(parameter           )                                             {
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

function parameterName(parameter           , sourceCode            )         {
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
		const aliases = new Map                       ();

		const resolvesToObject = (
			type               ,
			shadowedAliases                     ,
			visited = new Set        (),
		)          => {
			if (type.type === "TSObjectKeyword") return true;
			if (type.type === "TSParenthesizedType")
				return resolvesToObject(type.typeAnnotation, shadowedAliases, visited);
			if (type.type === "TSUnionType") {
				return type.types.some((member) =>
					resolvesToObject(member, shadowedAliases, visited),
				);
			}
			if (
				type.type !== "TSTypeReference" ||
				type.typeName.type !== "Identifier" ||
				(type.typeArguments !== null &&
					type.typeArguments !== undefined &&
					type.typeArguments.params.length > 0) ||
				visited.has(type.typeName.name) ||
				shadowedAliases.has(type.typeName.name)
			) {
				return false;
			}
			const alias = aliases.get(type.typeName.name);
			if (alias === undefined) return false;
			const nextVisited = new Set(visited);
			nextVisited.add(type.typeName.name);
			return resolvesToObject(alias, shadowedAliases, nextVisited);
		};

		const checkParameters = (node                ) => {
			const shadowedAliases = lexicalTypeParameterNames(
				node,
				context.sourceCode.visitorKeys,
			);
			for (const parameter of node.params) {
				const annotation = parameterAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				if (!resolvesToObject(annotation.typeAnnotation, shadowedAliases)) continue;
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
					if (
						declaration?.type === "TSTypeAliasDeclaration" &&
						(declaration.typeParameters === null || declaration.typeParameters === undefined)
					) {
						aliases.set(declaration.id.name, declaration.typeAnnotation);
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
