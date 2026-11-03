const assert = require("node:assert/strict");
const { create, assertDrain } = require("./media.cjs");
async function run() {
	assert.throws(() => assertDrain(null, 0, 500));
	assert.throws(() => assertDrain({ nonSilent: 5, lastNonSilentAt: 100 }, undefined, 500));
	assert.throws(() => assertDrain({ nonSilent: 5, lastNonSilentAt: 100 }, 300, 500));
	assert.throws(() => assertDrain({ nonSilent: 5, lastNonSilentAt: 450 }, 100, 500));
	assertDrain({ nonSilent: 5, lastNonSilentAt: 100 }, 200, 500);
	const report = { http: [], releases: [], speaks: [], narration: [] };
	const input = { sessionId: "controlled-session", turnId: "controlled-turn", generation: 1 };
	let clock = 100;
	let nonSilent = 10;
	const snapshot = () => ({
		remotes: [{ number: 1, local: 0, input: { nonSilent: 8 } }],
		outputs: [{ peer: 0, nonSilent, lastNonSilentAt: 100 }],
	});
	const M = create({
		report,
		fail: (e) => e,
		provider: {
			fetch: async () => {
				throw Error("Forbidden provider");
			},
		},
		js: async (code) => {
			if (code === "window.__handsSmoke.read()") return snapshot();
			if (code.startsWith("window.__handsSmoke.answer("))
				return { type: "answer", sdp: "controlled-selfcheck-only" };
			if (code.includes("performance.now()")) return clock;
		},
	});
	const call = (path, extra = {}) =>
		M.fetch(`http://127.0.0.1:12345/${path}`, {
			method: "POST",
			body: JSON.stringify({ ...input, ...extra }),
		});
	await call("offer", { sdp: "controlled-selfcheck-only" });
	M.enqueue("yes");
	await call("release");
	assert.equal((await (await call("poll", { afterSequence: 0 })).json()).events[0].text, "yes");
	await assert.rejects(() => call("release"), /Duplicate/);
	await call("speak", { speechId: "speech-1", text: "Exact controlled text." });
	await assert.rejects(() => M.observeReceipt({ ...input, requestId: "r" }), /speech-ended/);
	const s = [...M.sessions.values()][0];
	nonSilent = 20;
	await M.end(s);
	clock = 500;
	const proof = await M.observeReceipt({ ...input, requestId: "r" });
	assert.equal(proof.text, "Exact controlled text.");
	await call("cancel");
	await assert.rejects(() => M.observeReceipt({ ...input, requestId: "r" }));
	await assert.rejects(() => M.fetch("https://unexpected.invalid"), /Forbidden provider/);
	M.dispose();
	console.log(
		"STANDING_VOICE_SELF_CHECK_PASS: transport serialization, PCM/drain guards and cancellation only; no Electron, audio, network, SQLite or product acceptance executed"
	);
}
module.exports = { run };
if (require.main === module)
	run().catch((e) => {
		console.error(e);
		process.exitCode = 1;
	});
