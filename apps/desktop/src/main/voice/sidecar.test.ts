import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceDiagnosticError } from "./diagnostics";
import { VoiceSidecar } from "./sidecar";

const credentials = { meta: "test-meta", elevenlabs: "test-eleven", voiceId: "test-voice" };
// Real subprocess and loopback HTTP, no provider traffic. Node ignores appended --port after --.
const server = `
const http = require('node:http');
const server = http.createServer((req,res) => {
 if(req.headers.authorization !== 'Bearer '+process.env.VOICE_AUTH_TOKEN) {res.writeHead(401);res.end('{}');return;}
 let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const input=JSON.parse(body);
  res.setHeader('Content-Type','application/json');
  if(input.mode==='typed'){res.writeHead(502);res.end(JSON.stringify({detail:{stage:'meta',code:'auth',httpStatus:401}}));return;}
  if(input.mode==='unknown'){res.writeHead(502);res.end(JSON.stringify({detail:{stage:'meta',code:'secret-code',message:'private-body'}}));return;}
  if(input.mode==='oversized'){res.writeHead(502);res.end('x'.repeat(5000));return;}
  if(req.url==='/speak'){res.writeHead(502);res.end('test-meta sensitive upstream body');return;}
  res.end(JSON.stringify({body:JSON.parse(body),credentialsPresent:!!process.env.MODEL_API_KEY}));
 });
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
`;
describe("private sidecar lifecycle", () => {
	it("a cancellation before first offer does not start a credential-dependent child", async () => {
		let reads = 0;
		const sidecar = new VoiceSidecar({
			command: "/no-such-voice-binary",
			getCredentials: async () => {
				reads++;
				return {};
			},
		});
		assert.deepEqual(await sidecar.request("cancel", {}), {});
		assert.equal(reads, 0);
		await sidecar.dispose();
		await assert.rejects(sidecar.request("cancel", {}), /shut down/);
	});
	it("authenticates loopback requests, redacts failures, shuts down and rejects reuse", async () => {
		const sidecar = new VoiceSidecar({
			command: process.execPath,
			args: ["-e", server, "--"],
			getCredentials: async () => credentials,
		});
		try {
			assert.deepEqual(await sidecar.request("poll", { a: 1 }), {
				body: { a: 1 },
				credentialsPresent: true,
			});
			await assert.rejects(
				sidecar.request("speak", {}),
				(error) =>
					error instanceof VoiceDiagnosticError &&
					error.diagnostic.httpStatus === 502 &&
					!error.message.includes("sensitive")
			);
		} finally {
			await sidecar.dispose();
		}
		await assert.rejects(sidecar.request("poll", {}), /shut down/);
	});
	it("reports exact missing configuration before launching", async () => {
		const sidecar = new VoiceSidecar({
			command: "does-not-exist",
			getCredentials: async () => ({}),
		});
		await assert.rejects(
			sidecar.request("offer", {}),
			/MODEL_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID/
		);
		await sidecar.dispose();
	});
	it("does not launch if disposed during credential lookup", async () => {
		let finish!: (value: typeof credentials) => void;
		const sidecar = new VoiceSidecar({
			command: "does-not-exist",
			getCredentials: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const result = sidecar.request("offer", {});
		const rejection = assert.rejects(result, /shut down/);
		await sidecar.dispose();
		finish(credentials);
		await rejection;
	});
	it("bounds startup and handles executable errors without leaking raw stderr", async () => {
		const sidecar = new VoiceSidecar({
			command: process.execPath,
			args: ["-e", "setInterval(()=>{},1000)", "--"],
			startupTimeoutMs: 100,
			getCredentials: async () => credentials,
		});
		await assert.rejects(
			sidecar.request("offer", {}),
			(error) =>
				error instanceof VoiceDiagnosticError &&
				error.diagnostic.stage === "setup" &&
				error.diagnostic.code === "timeout"
		);
		await sidecar.dispose();
		const missing = new VoiceSidecar({
			command: "/no-such-voice-binary",
			getCredentials: async () => credentials,
		});
		await assert.rejects(
			missing.request("offer", {}),
			(error) => error instanceof VoiceDiagnosticError && error.diagnostic.code === "not-found"
		);
		await missing.dispose();
	});
	it("preserves only allowlisted HTTP diagnostic metadata and bounds rejected bodies", async () => {
		const sidecar = new VoiceSidecar({
			command: process.execPath,
			args: ["-e", server, "--"],
			getCredentials: async () => credentials,
		});
		try {
			await assert.rejects(sidecar.request("offer", { mode: "typed" }), (error) => {
				assert.ok(error instanceof VoiceDiagnosticError);
				assert.deepEqual(error.diagnostic, { stage: "meta", code: "auth", httpStatus: 401 });
				assert.match(error.message, /Meta speech authentication failed/);
				return true;
			});
			for (const mode of ["unknown", "oversized"])
				await assert.rejects(sidecar.request("offer", { mode }), (error) => {
					assert.ok(error instanceof VoiceDiagnosticError);
					assert.deepEqual(error.diagnostic, { stage: "media", code: "failed", httpStatus: 502 });
					assert.equal(/private|secret|xxxxx/.test(error.message), false);
					return true;
				});
		} finally {
			await sidecar.dispose();
		}
	});
});
