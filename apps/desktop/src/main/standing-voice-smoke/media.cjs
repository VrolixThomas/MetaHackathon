// Controlled transport from attention-smoke's real Chromium RTC/PCM harness.
const assert = require("node:assert/strict");
const { installControlledMedia, measureControlledPcm } = require("../hands-free-smoke.cjs");
const { response } = require("../comment-conversation-smoke/model.cjs");
const H = require("../standing-clarification-smoke/provider.cjs");
const identity = ({ sessionId, turnId, generation }) => ({ sessionId, turnId, generation });
const key = (value) => JSON.stringify(identity(value));
function assertDrain(output, endedAt, now) {
	assert.ok(output?.nonSilent > 3, "No decoded Chromium output PCM");
	assert.ok(Number.isFinite(endedAt), "No matching speech-ended");
	assert.ok(now - endedAt >= 280, "Receipt preceded 300ms product drain");
	assert.ok(now - output.lastNonSilentAt >= 150, "Receipt preceded PCM tail");
}
function create({ js, report, fail, provider }) {
	const sessions = new Map();
	const queue = [];
	let port;
	const media = () => js("window.__handsSmoke.read()");
	const event = (s, kind, fields) =>
		s.events.push({ ...s.identity, sequence: s.events.length + 1, kind, ...fields });
	const output = (m, s) => m.outputs.find((o) => o.peer === s.local);
	async function end(s) {
		assert.ok(!s.cancelled && s.speechId);
		s.endedAt = await js(`window.__handsSmoke.speak(${s.number},false); performance.now()`);
		s.currentSpeech.endedAt = s.endedAt;
		s.currentSpeech.decodedBeforeEnd = output(await media(), s);
		assert.ok(s.currentSpeech.decodedBeforeEnd.nonSilent > s.pcmBefore + 4);
		event(s, "speech-ended", { speechId: s.speechId });
	}
	async function fetch(input, options = {}) {
		try {
			const url = new URL(String(input.url ?? input));
			if (url.href === H.MODEL) {
				const body = JSON.parse(options.body);
				// The negative confirmation still exercises the real tool. Its rejected output
				// is not a successful activation and must not be asserted active by typed fixture.
				const lastUser = body.input.findLastIndex(
					(i) => i.role === "user" && typeof i.content === "string"
				);
				const calls = body.input.slice(lastUser + 1);
				const confirm = calls.find(
					(i) => i.type === "function_call" && i.name === "standing_clarification_confirm"
				);
				const result =
					confirm &&
					calls.find((i) => i.type === "function_call_output" && i.call_id === confirm.call_id);
				if (result && JSON.parse(result.output).status !== "active") {
					report.http.push({ kind: "rejected-confirmation-result", output: result.output });
					return response(body, { text: "No standing rule was activated." });
				}
				return provider.fetch(input, options);
			}
			if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
				return provider.fetch(input, options);
			assert.ok(!url.username && !url.password && !url.search);
			assert.ok(["/offer", "/release", "/speak", "/poll", "/cancel"].includes(url.pathname));
			assert.equal(options.method, "POST");
			port ??= url.port;
			assert.equal(url.port, port);
			const body = JSON.parse(options.body);
			let s = sessions.get(key(body));
			if (url.pathname === "/offer") {
				assert.ok(!s);
				s = {
					identity: identity(body),
					number: sessions.size + 1,
					events: [],
					cancelled: false,
					texts: [],
				};
				sessions.set(key(body), s);
				const answer = await js(`window.__handsSmoke.answer(${JSON.stringify(body)},${s.number})`);
				await js(`window.__handsSmoke.markAnswer(${s.number})`);
				s.local = (await media()).remotes.find((r) => r.number === s.number).local;
				return Response.json(answer);
			}
			if (url.pathname === "/cancel") {
				if (s) {
					s.cancelled = true;
					await js(`window.__handsSmoke.cancel(${s.number})`);
				}
				return Response.json({});
			}
			assert.ok(s);
			if (url.pathname === "/poll")
				return Response.json({ events: s.events.filter((e) => e.sequence > body.afterSequence) });
			assert.equal(s.cancelled, false);
			if (url.pathname === "/release") {
				assert.ok(!s.released, "Duplicate capture release");
				const captured = (await media()).remotes.find((r) => r.number === s.number);
				assert.ok(captured.input.nonSilent > 3, "No actual captured RTC PCM");
				const text = queue.shift();
				assert.equal(typeof text, "string", "Unscheduled voice ingress");
				s.released = true;
				s.transcript = text;
				report.releases.push({ ...s.identity, text, captured, at: Date.now() });
				event(s, "transcript", { text, final: true });
				return Response.json({});
			}
			assert.equal(url.pathname, "/speak");
			assert.ok(!s.speechId || Number.isFinite(s.endedAt), "Overlapping speech");
			if (s.speechId) {
				const m = await media();
				const at = await js("performance.now()");
				assertDrain(output(m, s), s.endedAt, at);
				s.currentSpeech.drainObservedAt = at;
			}
			s.pcmBefore = output(await media(), s)?.nonSilent ?? 0;
			s.speechId = body.speechId;
			s.endedAt = undefined;
			s.texts.push(body.text);
			s.currentSpeech = {
				...s.identity,
				speechId: body.speechId,
				text: body.text,
				pcmBefore: s.pcmBefore,
			};
			report.speaks.push(s.currentSpeech);
			event(s, "speech-started", { speechId: s.speechId });
			await js(`window.__handsSmoke.speak(${s.number},true)`);
			return Response.json({});
		} catch (error) {
			throw fail(error);
		}
	}
	return {
		fetch,
		sessions,
		media,
		output,
		end,
		install: () => js(`(${installControlledMedia.toString()})(${measureControlledPcm.toString()})`),
		enqueue: (text) => queue.push(text),
		async observeReceipt(input) {
			const s = sessions.get(key(input));
			assert.ok(s && !s.cancelled);
			const m = await media();
			const now = await js("performance.now()");
			assertDrain(output(m, s), s.endedAt, now);
			s.currentSpeech.drainObservedAt = now;
			const proof = {
				...identity(input),
				requestId: input.requestId,
				speechId: s.speechId,
				text: s.texts.join(" "),
				output: output(m, s),
				endedAt: s.endedAt,
				observedAt: now,
			};
			report.narration.push(proof);
			return proof;
		},
		async verifyStopped() {
			if (!port) return false;
			await new Promise((resolve, reject) => {
				const socket = require("node:net").createConnection({
					host: "127.0.0.1",
					port: Number(port),
				});
				socket.setTimeout(1000);
				socket.once("connect", () => {
					socket.destroy();
					reject(Error("Owned voice sidecar survived shutdown"));
				});
				socket.once("timeout", () => {
					socket.destroy();
					reject(Error("Voice sidecar shutdown probe timed out"));
				});
				socket.once("error", (error) =>
					error.code === "ECONNREFUSED" ? resolve() : reject(error)
				);
			});
			return true;
		},
		dispose() {
			queue.length = 0;
		},
	};
}
module.exports = { create, key, assertDrain };
