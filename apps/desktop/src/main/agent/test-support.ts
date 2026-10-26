import { getReviewFixture } from "../../shared/fixtures/review";
import { CommentDrafts } from "./comments";
import { MetaClient, type MetaItem } from "./meta-client";
import type { AgentPorts } from "./tool-loop";

export function completed(output: MetaItem[] = []) {
	return {
		type: "response.completed",
		response: {
			id: "response-test",
			model: "muse-spark-1.3",
			status: "completed",
			output,
			usage: { input_tokens: 10, output_tokens: 10 },
		},
	};
}
export function call(name: string, args: unknown, callId = "call-1"): MetaItem {
	return {
		type: "function_call",
		call_id: callId,
		name,
		arguments: JSON.stringify(args),
		status: "completed",
	};
}
export function transport(events: unknown[]) {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}
export function testContext(responses: unknown[][]) {
	const fixture = getReviewFixture();
	const requests: Record<string, unknown>[] = [];
	let posts = 0;
	const drafts = new CommentDrafts({
		getPullRequest: async () => fixture.preparation.pr,
		postConfirmedComment: async () => {
			posts++;
			return { url: "https://github.com/demo/shop-web/pull/1284#test" };
		},
	});
	const ports: AgentPorts = {
		getPreparation: async () => fixture.preparation,
		getScreenContext: () => fixture.screenContext,
		getScenario: async () => fixture.scenario,
		getPreview: async () => fixture.preview,
		getDiagram: async () => fixture.diagram,
		validateLocation: async () => true,
		drafts,
	};
	const client = new MetaClient({
		getApiKey: async () => "test-key",
		recordUsage: () => {},
		fetch: async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			const events = responses.shift();
			if (!events) throw new Error("Unexpected model request");
			return transport(events);
		},
	});
	return { fixture, ports, client, requests, postCount: () => posts };
}

export async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Expected condition did not settle");
}
