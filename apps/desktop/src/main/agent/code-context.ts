import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { z } from "zod";
import {
	type CodeLocation,
	CodeLocationSchema,
	DiagramSpecSchema,
	EvidenceSchema,
	PullRequestSchema,
	RepositoryPathSchema,
} from "../../shared/contracts";

const inputSchema = z.strictObject({
	pr: PullRequestSchema,
	revision: z.enum(["base", "head"]),
	files: z
		.array(z.strictObject({ path: RepositoryPathSchema, source: z.string().max(1_000_000) }))
		.max(1000),
	changed: z.array(CodeLocationSchema).min(1),
	evidence: EvidenceSchema,
});
type FunctionNode = { id: string; label: string; location: CodeLocation };
type CallEdge = { caller: string; callee: string; callsite: CodeLocation };

/** Pure analysis of runtime-provided source snapshots. The compiler host never reads disk. */
export function findCodeContext(raw: unknown) {
	const input = inputSchema.parse(raw);
	const sha = input.revision === "base" ? input.pr.baseSha : input.pr.headSha;
	for (const change of input.changed) {
		if (
			change.repository !== input.pr.repository ||
			change.revision !== input.revision ||
			change.commitSha !== sha
		)
			throw new Error("Changed location belongs to another revision");
	}
	if (new Set(input.files.map((file) => file.path)).size !== input.files.length)
		throw new Error("Duplicate source snapshot");
	if (input.files.reduce((size, file) => size + file.source.length, 0) > 10_000_000)
		throw new Error("Source snapshot exceeds analysis limit");
	const sources = new Map(
		input.files
			.filter((file) => /\.[cm]?[jt]sx?$/.test(file.path))
			.map((file) => [posix.resolve("/repo", file.path), file.source])
	);
	const options: ts.CompilerOptions = {
		noLib: true,
		noEmit: true,
		allowJs: true,
		checkJs: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Node10,
		jsx: ts.JsxEmit.Preserve,
		allowImportingTsExtensions: true,
	};
	const canonical = (path: string) => posix.normalize(path);
	const host: ts.CompilerHost = {
		getSourceFile: (fileName, languageVersion) => {
			const source = sources.get(canonical(fileName));
			return source === undefined
				? undefined
				: ts.createSourceFile(fileName, source, languageVersion, true);
		},
		getDefaultLibFileName: () => "/no-libs.d.ts",
		writeFile: () => {},
		getCurrentDirectory: () => "/repo",
		getDirectories: () => [],
		directoryExists: (directory) =>
			[...sources.keys()].some((path) => path.startsWith(`${canonical(directory)}/`)),
		getCanonicalFileName: canonical,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (fileName) => sources.has(canonical(fileName)),
		readFile: (fileName) => sources.get(canonical(fileName)),
	};
	const program = ts.createProgram([...sources.keys()], options, host);
	if (program.getSyntacticDiagnostics().length)
		throw new Error("Invalid source syntax; context cannot be resolved");
	const checker = program.getTypeChecker();
	const nodes = new Map<ts.Node, FunctionNode>();
	const modules = new Map<ts.SourceFile, FunctionNode>();
	const location = (node: ts.Node): CodeLocation => {
		const source = node.getSourceFile();
		return CodeLocationSchema.parse({
			repository: input.pr.repository,
			revision: input.revision,
			commitSha: sha,
			path: posix.relative("/repo", source.fileName),
			startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
			endLine:
				source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.end - 1)).line +
				1,
		});
	};
	const makeNode = (node: ts.Node, label: string): FunctionNode => {
		const loc = location(node);
		return {
			id: createHash("sha256")
				.update(`${loc.path}:${node.kind}:${node.pos}:${node.end}:${sha}`)
				.digest("hex")
				.slice(0, 24),
			label,
			location: loc,
		};
	};
	function visitDefinitions(node: ts.Node) {
		if (ts.isFunctionLike(node) && "body" in node && node.body) {
			const name =
				node.name?.getText() ??
				(ts.isConstructorDeclaration(node) &&
				(ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))
					? `${node.parent.name?.getText() ?? "anonymous class"} constructor`
					: ts.isVariableDeclaration(node.parent)
						? node.parent.name.getText()
						: "anonymous callback");
			nodes.set(node, makeNode(node, name));
		}
		ts.forEachChild(node, visitDefinitions);
	}
	for (const source of program.getSourceFiles()) {
		modules.set(source, makeNode(source, `${posix.relative("/repo", source.fileName)} module`));
		visitDefinitions(source);
	}
	const calls: CallEdge[] = [];
	const unresolved: { expression: string; location: CodeLocation }[] = [];
	function visitCalls(node: ts.Node, owner: FunctionNode) {
		const caller = nodes.get(node) ?? owner;
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const declaration = checker.getResolvedSignature(node)?.declaration;
			let callee = declaration ? nodes.get(declaration) : undefined;
			if (!callee) {
				let symbol = checker.getSymbolAtLocation(node.expression);
				if (symbol && symbol.flags & ts.SymbolFlags.Alias)
					symbol = checker.getAliasedSymbol(symbol);
				for (const candidate of symbol?.declarations ?? []) {
					callee = nodes.get(candidate);
					if (!callee && ts.isVariableDeclaration(candidate) && candidate.initializer)
						callee = nodes.get(candidate.initializer);
					if (callee) break;
				}
			}
			if (callee) calls.push({ caller: caller.id, callee: callee.id, callsite: location(node) });
			else
				unresolved.push({
					expression: node.expression.getText().slice(0, 500),
					location: location(node),
				});
		}
		ts.forEachChild(node, (child) => visitCalls(child, caller));
	}
	for (const [source, owner] of modules) visitCalls(source, owner);
	const allNodes = [...nodes.values(), ...modules.values()];
	const changed = [...nodes.values()].filter((node) =>
		input.changed.some(
			(change) =>
				change.path === node.location.path &&
				change.startLine <= node.location.endLine &&
				change.endLine >= node.location.startLine
		)
	);
	if (!changed.length)
		throw new Error("No function implementation overlaps the supplied changed locations");
	const changedIds = new Set(changed.map((node) => node.id));
	const relevantCalls = calls.filter(
		(call) => changedIds.has(call.caller) || changedIds.has(call.callee)
	);
	const relevantIds = new Set([
		...changedIds,
		...relevantCalls.flatMap((call) => [call.caller, call.callee]),
	]);
	const uniqueEdges = new Map<string, { from: string; to: string; label: string }>();
	for (const call of relevantCalls)
		uniqueEdges.set(`${call.caller}:${call.callee}`, {
			from: call.caller,
			to: call.callee,
			label: "statically resolved call",
		});
	const diagram = DiagramSpecSchema.parse({
		id: `context-${sha.slice(0, 12)}`,
		prId: input.pr.id,
		title: "Callers and callees in inspected source files",
		nodes: allNodes.filter((node) => relevantIds.has(node.id)),
		edges: [...uniqueEdges.values()],
		evidence: input.evidence,
	});
	return {
		diagram,
		calls: relevantCalls,
		functions: changed.map((node) => ({
			...node,
			callerCount: relevantCalls.filter((call) => call.callee === node.id).length,
		})),
		unresolvedCalls: unresolved,
		coverage: {
			inspectedFiles: [...sources.keys()].map((path) => posix.relative("/repo", path)),
			complete: false as const,
			limitation:
				"Counts cover statically resolved call sites in these snapshots. Dynamic dispatch, callbacks passed as values, external modules and project path aliases may be unresolved.",
		},
	};
}
