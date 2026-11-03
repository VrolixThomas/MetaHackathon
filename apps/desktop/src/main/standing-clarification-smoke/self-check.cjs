// Node-only transport sanity check. No Electron, SQLite, sockets, provider calls or app imports.
const assert = require("node:assert/strict");
const H = require("./provider.cjs");
async function run() {
	const report = { http: [], posts: [] };
	const p = H.create({
		report,
		day: () => ({ records: [] }),
		standing: () => ({ rules: [], admissions: [] }),
		fail: (e) => e,
	});
	const a = p.add("one");
	const b = p.add("two");
	assert.notEqual(a.ts, b.ts);
	const slack = (fields) =>
		p.fetch("https://slack.com/api/conversations.history", {
			method: "POST",
			redirect: "error",
			headers: { authorization: `Bearer ${H.TOKEN}` },
			body: new URLSearchParams({ channel: H.CHANNEL, limit: "15", ...fields }).toString(),
		});
	assert.deepEqual(
		(await (await slack({})).json()).messages.map((m) => m.ts),
		[b.ts, a.ts]
	);
	assert.deepEqual(
		(await (await slack({ oldest: a.ts, latest: a.ts, inclusive: "true" })).json()).messages,
		[a]
	);
	const body = {
		stream: true,
		store: false,
		instructions: "Controlled foreground",
		input: [{ role: "user", content: "Propose a standing clarification rule for first." }],
		tools: [{ name: "standing_clarification_list" }, { name: "standing_clarification_propose" }],
	};
	const sse = await (
		await p.fetch(H.MODEL, {
			method: "POST",
			headers: { authorization: `Bearer ${H.MODEL_KEY}` },
			body: JSON.stringify(body),
		})
	).text();
	const event = JSON.parse(sse.trim().slice(6));
	assert.equal(event.response.output[0].name, "standing_clarification_propose");
	assert.deepEqual(JSON.parse(event.response.output[0].arguments), H.POLICY);
	assert.ok(H.canonical().endsWith("Activate this rule?"));
	await assert.rejects(p.fetch("https://example.invalid/", { method: "POST" }));
	assert.equal(report.posts.length, 0);
	console.log(
		"STANDING_SELF_CHECK_PASS: controlled protocol only; no native/app/database/audio/network execution"
	);
}
run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
