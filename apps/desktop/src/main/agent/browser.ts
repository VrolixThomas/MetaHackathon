import { z } from "zod";
import {
	type AgentTurnInput,
	type BrowserCommand,
	BrowserCommandSchema,
	type BrowserState,
	BrowserStateSchema,
	BrowserViewportSchema,
	IdSchema,
	type PRPreparation,
	RevisionSchema,
} from "../../shared/contracts";
import { abortable, throwIfAborted } from "./cancellation";
import type { FunctionTool } from "./meta-client";

/** Runtime operates the very same page displayed to the reviewer. No agent-owned browser. */
export interface AgentBrowserPort {
	execute: (command: BrowserCommand, signal: AbortSignal) => Promise<BrowserState>;
	observe: (sessionId: string, signal: AbortSignal) => Promise<BrowserState | null>;
}

const target = { browserId: IdSchema };
const element = { ...target, elementId: IdSchema, observationSequence: z.int().nonnegative() };
const argumentsByTool = {
	browser_open: z.strictObject({ revision: RevisionSchema, path: z.string().max(2000).optional() }),
	browser_observe: z.strictObject({}),
	browser_navigate: z.strictObject({ ...target, url: z.url() }),
	browser_click: z.strictObject(element),
	browser_type: z.strictObject({ ...element, text: z.string().max(4000) }),
	browser_scroll: z.strictObject({
		...target,
		x: z.number().finite().optional(),
		y: z.number().finite().optional(),
		elementId: IdSchema.optional(),
		observationSequence: z.int().nonnegative().optional(),
	}),
	browser_viewport: z.strictObject({ ...target, viewport: BrowserViewportSchema }),
};
type BrowserToolName = keyof typeof argumentsByTool;
const descriptions: Record<BrowserToolName, string> = {
	browser_open:
		"Open the current PR's head or base in the reviewer's persistent visible browser. Use head for checkout, base for before-PR comparison. Runtime supplies the local preview URL. Reopening may replace revision state; inspect the returned page.",
	browser_observe:
		"Read the reviewer's actual browser page and refresh element references. Returns no page if none is open. Does not run a test.",
	browser_navigate:
		"Navigate the same visible browser to a URL on its current local preview origin. Use an observed link or source-grounded route.",
	browser_click:
		"Click an enabled, visible element from the latest browser observation. Supply its exact browserId, elementId and observationSequence. Read the result before deciding the next step.",
	browser_type:
		"Fill an enabled, visible input from the latest browser observation. Does not submit it; inspect the refreshed page before clicking its submit/apply control.",
	browser_scroll:
		"Scroll the visible page to an observed element (elementId and observationSequence), or to absolute x/y CSS coordinates. To show the payment button, scroll to its observed ref; do not click it.",
	browser_viewport:
		"Resize the same visible page. Use 390x844 for a phone request, 1024x768 for desktop. Preserve page interaction state and inspect the resulting layout.",
};
export const BROWSER_TOOLS: FunctionTool[] = Object.entries(argumentsByTool).map(
	([name, schema]) => ({
		type: "function",
		name,
		description: descriptions[name as BrowserToolName],
		parameters: z.toJSONSchema(schema) as Record<string, unknown>,
	})
);
export function isBrowserTool(name: string): name is BrowserToolName {
	return Object.hasOwn(argumentsByTool, name);
}

export function parseBrowserState(
	raw: unknown,
	sessionId: string,
	prep: PRPreparation
): BrowserState {
	const state = BrowserStateSchema.parse(raw);
	if (
		state.sessionId !== sessionId ||
		state.prId !== prep.pr.id ||
		state.repository !== prep.pr.repository ||
		state.commitSha !== (state.revision === "base" ? prep.pr.baseSha : prep.pr.headSha)
	)
		throw new Error("Browser observation does not match this review session and pinned PR");
	for (const { location } of state.elements) {
		if (
			location &&
			(location.repository !== state.repository ||
				location.revision !== state.revision ||
				location.commitSha !== state.commitSha)
		)
			throw new Error("Browser code location does not match its page revision");
	}
	return state;
}

export async function observeBrowser(
	port: AgentBrowserPort,
	sessionId: string,
	prep: PRPreparation,
	signal: AbortSignal
): Promise<BrowserState | null> {
	throwIfAborted(signal);
	const raw = await abortable(port.observe(sessionId, signal), signal);
	throwIfAborted(signal);
	return raw === null ? null : parseBrowserState(raw, sessionId, prep);
}

export async function dispatchBrowserTool(
	name: BrowserToolName,
	raw: unknown,
	port: AgentBrowserPort,
	context: {
		turn: AgentTurnInput;
		prep: PRPreparation;
		browser: BrowserState | undefined;
		requestId: string;
		signal: AbortSignal;
	}
): Promise<BrowserState | null> {
	const { turn, prep, browser, requestId, signal } = context;
	throwIfAborted(signal);
	const args = argumentsByTool[name].parse(raw);
	if (name === "browser_observe") return observeBrowser(port, turn.sessionId, prep, signal);
	const command = BrowserCommandSchema.parse({
		...args,
		kind: name.slice("browser_".length),
		sessionId: turn.sessionId,
		requestId,
		...(name === "browser_open" ? { prId: prep.pr.id } : {}),
	});
	if (command.kind !== "open") {
		if (!browser || command.browserId !== browser.browserId)
			throw new Error("Browser target is no longer current");
		if ("elementId" in command && command.elementId !== undefined) {
			const element = browser.elements.find((item) => item.id === command.elementId);
			if (!element || command.observationSequence !== browser.sequence)
				throw new Error("Browser element reference is stale; observe again");
			if (command.kind !== "scroll" && (!element.visible || !element.enabled))
				throw new Error("Browser element cannot be interacted with");
		}
		if (command.kind === "navigate" && new URL(command.url).origin !== new URL(browser.url).origin)
			throw new Error("Browser navigation must remain on the current preview origin");
	}
	const expectedRevision = command.kind === "open" ? command.revision : browser?.revision;
	const expectedBrowserId = command.kind === "open" ? undefined : command.browserId;
	const executed = parseBrowserState(
		await abortable(port.execute(structuredClone(command), signal), signal),
		turn.sessionId,
		prep
	);
	throwIfAborted(signal);
	if (
		executed.revision !== expectedRevision ||
		(expectedBrowserId !== undefined && executed.browserId !== expectedBrowserId)
	)
		throw new Error("Browser result belongs to another page");
	// Read again rather than treating the requested effect or the execute acknowledgement
	// as proof of the page's current contents. Runtime must use actual DOM observations.
	const observed = await observeBrowser(port, turn.sessionId, prep, signal);
	if (
		!observed ||
		observed.browserId !== executed.browserId ||
		observed.revision !== executed.revision ||
		observed.sequence < executed.sequence
	)
		throw new Error("Browser changed before its action could be observed");
	return observed;
}
