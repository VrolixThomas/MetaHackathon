import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceSidecar } from "./sidecar";

const credentials = { meta: "test-meta", elevenlabs: "test-eleven", voiceId: "test-voice" };
// Real subprocess and loopback HTTP, no provider traffic. Node ignores appended --port after --.
const server = `
const http = require('node:http');
const server = http.createServer((req,res) => {
 if(req.headers.authorization !== 'Bearer '+process.env.VOICE_AUTH_TOKEN) {res.writeHead(401);res.end('{}');return;}
 let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/speak'){res.writeHead(502);res.end('test-meta sensitive upstream body');return;}
  res.end(JSON.stringify({body:JSON.parse(body),credentialsPresent:!!process.env.MODEL_API_KEY}));
 });
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
`;
describe("private sidecar lifecycle", () => {
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
				(error) => error instanceof Error && error.message === "Voice speak failed (HTTP 502)"
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
		await assert.rejects(sidecar.request("offer", {}), /startup timed out/);
		await sidecar.dispose();
		const missing = new VoiceSidecar({
			command: "/no-such-voice-binary",
			getCredentials: async () => credentials,
		});
		await assert.rejects(missing.request("offer", {}), /could not start/);
		await missing.dispose();
	});
});
