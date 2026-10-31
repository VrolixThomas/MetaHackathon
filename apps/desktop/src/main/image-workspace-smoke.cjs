// ROOT ONLY after integration build: env -u ELECTRON_RUN_AS_NODE electron src/main/image-workspace-smoke.cjs [built-main]
// Author checks only: node --check this-file; node this-file --self-check.
// Actual default App/IPC/ImageService/Gemini adapter/files/Chromium decode. Only providers are controlled HTTP.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const support = require("./image-workspace-smoke/support.cjs");
const { MODEL_URL, IMAGE_URL, TITLE, PNG, SHA, imageResult, modelResult, DOM, assertFrame } =
	support;
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function wait(label, read, milliseconds = 25000) {
	const end = Date.now() + milliseconds;
	while (Date.now() < end) {
		const result = await read();
		if (result) return result;
		await pause(40);
	}
	throw new Error(`Timed out: ${label}`);
}
async function native() {
	assert.ok(
		process.versions.electron && !process.env.ELECTRON_RENDERER_URL,
		"Root must launch actual built Electron; author may run --self-check only"
	);
	const { app, BrowserWindow, ipcMain, session } = require("electron");
	const builtMain = resolve(process.argv[2] ?? join(__dirname, "../../out/main/index.js"));
	assert.ok(fs.existsSync(builtMain), "Build integration first");
	for (const key of Object.keys(process.env))
		if (
			/(?:TOKEN|SECRET|API_KEY|CLIENT_ID|VOICE_ID)/i.test(key) ||
			/^(?:SLACK_|LINEAR_|GITHUB_|GH_|META_|MODEL_|ELEVENLABS_|MUSE_|IMAGE_PROVIDER)/.test(key)
		)
			delete process.env[key];
	const owned = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "muse-image-native-")));
	const owner = randomUUID();
	fs.writeFileSync(join(owned, ".owner"), owner, { mode: 0o600 });
	const userData = join(owned, "profile");
	fs.mkdirSync(userData);
	app.setPath("userData", userData);
	const envPath = join(owned, ".env");
	const writeEnvironment = (withImages) =>
		fs.writeFileSync(
			envPath,
			`MODEL_API_KEY=controlled-image-model-only\n${withImages ? "IMAGE_PROVIDER=gemini\nGEMINI_API_KEY=controlled-image-provider-only\n" : ""}`,
			{ mode: 0o600 }
		);
	writeEnvironment(true);
	process.env.METAHACKATHON_ENV_FILE = envPath;
	const out = join(__dirname, "../../out");
	fs.mkdirSync(out, { recursive: true });
	const reportPath = join(out, "image-workspace-smoke-report.json");
	const report = {
		status: "running",
		actualAppIPC: true,
		actualImageService: true,
		controlledHTTP: true,
		liveProviders: false,
		liveSpeech: false,
		microphone: false,
		steps: [],
		ipc: [],
		imageRequests: [],
		modelCalls: 0,
		blocked: [],
		permissions: [],
	};
	const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	let win;
	let origin;
	let cancelledResponse;
	let cancellationEntered = false;
	let cancellationClosed = false;
	let stopping = false;
	const server = http.createServer(async (request, response) => {
		try {
			assert.equal(request.method, "POST");
			assert.ok(["/model", "/image"].includes(request.url));
			const chunks = [];
			let length = 0;
			for await (const chunk of request) {
				length += chunk.length;
				assert.ok(length <= 256 * 1024);
				chunks.push(chunk);
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (request.url === "/model") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(modelResult(body, ++report.modelCalls));
				return;
			}
			assert.equal(request.headers["x-goog-api-key"], "controlled-image-provider-only");
			const result = imageResult(body);
			const prompt = body.contents[0].parts[0].text;
			report.imageRequests.push({ prompt, actualHTTP: true });
			if (prompt === "Generate cancelled image") {
				cancellationEntered = true;
				cancelledResponse = { response, result };
				response.on("close", () => {
					cancellationClosed = true;
				});
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
		} catch (error) {
			report.serverError = error.message;
			response.writeHead(500);
			response.end("Controlled provider protocol rejected");
		}
	});
	const originalFetch = globalThis.fetch;
	const originalHandle = ipcMain.handle;
	globalThis.fetch = (input, options = {}) => {
		const url = String(input.url ?? input);
		if (url === MODEL_URL || url === IMAGE_URL) {
			assert.equal(options.method, "POST");
			return originalFetch(`${origin}${url === MODEL_URL ? "/model" : "/image"}`, {
				...options,
				redirect: "error",
			});
		}
		report.blocked.push(new URL(url).origin);
		return Promise.reject(new Error("External provider forbidden by controlled image smoke"));
	};
	// Observe genuine IPC unchanged. Positive receipts get independent actual DOM/frame checks.
	ipcMain.handle = function (channel, handler) {
		if (channel !== "trpc:request") return originalHandle.call(this, channel, handler);
		return originalHandle.call(this, channel, async (event, request) => {
			const path = request?.path;
			const input = request?.input?.json;
			const audited = [
				"workspace.applied",
				"workspace.prepare",
				"images.read",
				"conversation.start",
				"conversation.cancel",
			].includes(path);
			const row = audited
				? { path, input: structuredClone(input), startedAt: new Date().toISOString() }
				: null;
			if (row) report.ipc.push(row);
			try {
				if (path === "workspace.applied" && input?.status === "applied") {
					const canvases = input.workspace?.canvases ?? [];
					const image = canvases.find((canvas) => canvas.kind === "image");
					// Root receipt schema is authoritative; DOM probes below also cover every image receipt.
					if (image && win) {
						const frames = await win.webContents.executeJavaScript(
							`new Promise(resolve=>requestAnimationFrame(()=>{const a=${DOM};requestAnimationFrame(()=>resolve([a,${DOM}]))}))`
						);
						for (const frame of frames) assertFrame(frame, image.asset);
						row.actualDecodedFrames = frames.map(({ images, sequence }) => ({ images, sequence }));
					}
				}
				const result = await handler(event, request);
				if (row) {
					row.completed = true;
					row.error = result?.error?.message;
					row.result =
						path === "images.read" ? { readReturned: !result?.error } : structuredClone(result);
				}
				return result;
			} catch (error) {
				if (row) row.error = error.message;
				throw error;
			}
		});
	};
	app.on("browser-window-created", (_event, window) => {
		window.setFocusable(false);
		window.setIgnoreMouseEvents(true);
	});
	const closeServer = () =>
		new Promise((done) => {
			server.close(done);
			server.closeAllConnections();
		});
	const finish = async (error) => {
		if (stopping) return;
		stopping = true;
		report.status = error ? "failed" : "passed";
		if (error) {
			report.error = error.stack ?? String(error);
			if (win && !win.isDestroyed()) {
				try {
					fs.writeFileSync(
						join(out, "image-workspace-smoke-failure.png"),
						(await win.webContents.capturePage()).toPNG()
					);
				} catch {}
			}
		}
		save();
		await closeServer();
		app.quit();
	};
	const deadline = setTimeout(
		() => void finish(new Error("Image native smoke hard deadline")),
		150000
	);
	app.on("will-quit", () => {
		clearTimeout(deadline);
		globalThis.fetch = originalFetch;
		ipcMain.handle = originalHandle;
		try {
			assert.equal(server.listening, false);
			assert.equal(fs.readFileSync(join(owned, ".owner"), "utf8"), owner);
			fs.rmSync(owned, { recursive: true });
			report.cleanup = { ownedRemoved: !fs.existsSync(owned), serverClosed: true };
		} catch (error) {
			report.status = "failed";
			report.cleanupError = error.message;
		}
		save();
		console.log(`IMAGE_WORKSPACE_SMOKE_${report.status.toUpperCase()}: ${reportPath}`);
		if (report.status !== "passed") app.exit(1);
	});
	try {
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		origin = `http://127.0.0.1:${server.address().port}`;
		await app.whenReady();
		session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
			report.permissions.push(permission);
			callback(false);
		});
		session.defaultSession.setPermissionCheckHandler(() => false);
		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			const url = new URL(details.url);
			const allowed = ["file:", "data:", "blob:", "devtools:"].includes(url.protocol);
			if (!allowed) report.blocked.push(url.origin);
			callback({ cancel: !allowed });
		});
		await import(pathToFileURL(builtMain).href);
		win = await wait("actual default App window", () => BrowserWindow.getAllWindows()[0]);
		await wait("built renderer", () => !win.webContents.isLoadingMainFrame());
		const js = (code) => win.webContents.executeJavaScript(code);
		const rpc = async (type, path, input = null) => {
			const response = await js(
				`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
			);
			assert.ok(!response.error, `${path}: ${JSON.stringify(response.error)}`);
			return response.result.data.json;
		};
		await wait("startup session", () =>
			js(`!!document.querySelector('main.conversation-main')?.dataset.sessionId`)
		);
		const sessionId = (await js(DOM)).sessionId;
		const observe = () => rpc("query", "workspace.observe", { sessionId });
		const initial = await observe();
		assert.equal(
			initial.workspace.canvases.some((canvas) => canvas.kind === "image"),
			false
		);
		if (!(await js(`!!document.querySelector('textarea[name="question"]')?.checkVisibility()`))) {
			await js(`document.querySelector('[data-testid="workspace-more"]').click()`);
			await wait("workspace menu", () => js(`document.querySelector('#workspace-more')?.open`));
			await js(`document.querySelector('[data-testid="conversation-toggle"]').click()`);
		}
		await wait("actual typing composer", () =>
			js(`document.querySelector('textarea[name="question"]')?.checkVisibility()`)
		);
		const start = async (text) => {
			const prior = (await js(DOM)).turnId;
			await js(
				`(()=>{const e=document.querySelector('textarea[name="question"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
			);
			await wait("enabled Send", () =>
				js(`!!document.querySelector('[aria-label="Send message"]:not(:disabled)')`)
			);
			await js(`document.querySelector('textarea[name="question"]').form.requestSubmit()`);
			return wait("new actual user turn", async () => {
				const state = await js(DOM);
				return state.turnId && state.turnId !== prior ? state : null;
			});
		};
		const settle = (turnId) =>
			wait(
				"settled actual turn",
				async () => {
					const state = await js(DOM);
					return state.turnId === turnId && ["complete", "error", "cancelled"].includes(state.phase)
						? state
						: null;
				},
				35000
			);
		const step = async (label, work) => {
			await work();
			report.steps.push({ label, passed: true });
			save();
			console.log(`IMAGE_WORKSPACE_STEP_PASS: ${label}`);
		};
		let asset;
		let canvasId;
		await step(
			"actual typed tool, ImageService, Gemini controlled HTTP, private PNG and decoded canvas receipt",
			async () => {
				const turn = await start("Generate controlled image");
				assert.equal((await settle(turn.turnId)).phase, "complete");
				const observed = await observe();
				const canvas = observed.workspace.canvases.find((item) => item.kind === "image");
				assert.ok(canvas);
				asset = canvas.asset;
				canvasId = canvas.id;
				assert.equal(asset.sha256, SHA);
				assert.equal(asset.width, 2);
				assert.equal(asset.height, 2);
				assert.equal(asset.provenance, "provider-generated");
				assert.equal(observed.workspace.primaryId, canvas.id);
				const frames = await js(
					`new Promise(resolve=>requestAnimationFrame(()=>{const a=${DOM};requestAnimationFrame(()=>resolve([a,${DOM}]))}))`
				);
				for (const frame of frames) assertFrame(frame, asset);
				const read = await rpc("query", "images.read", { id: asset.id });
				assert.equal(read.dataUrl, `data:image/png;base64,${PNG.toString("base64")}`);
				assert.deepEqual(
					fs.readFileSync(join(userData, "workspace", "images", `${asset.id}.png`)),
					PNG
				);
				assert.equal(report.imageRequests.length, 1);
				assert.ok(
					report.ipc.some(
						(row) =>
							row.path === "workspace.applied" &&
							row.completed &&
							!row.error &&
							row.input.status === "applied" &&
							row.actualDecodedFrames?.length === 2 &&
							row.input.workspace?.canvases.some(
								(canvas) => canvas.kind === "image" && canvas.asset.id === asset.id
							)
					)
				);
				report.generated = { asset, canvasId, actualFrames: frames };
			}
		);
		await step(
			"persisted descriptor closes into actual Recent and reopens same decoded bytes without regeneration",
			async () => {
				await js(`document.querySelector('[aria-label="Close ${TITLE}"]').click()`);
				await wait("closed image saved in Recent", async () => {
					const observation = await observe();
					return (
						!observation.workspace.canvases.some((canvas) => canvas.id === canvasId) &&
						observation.savedCanvases?.some(
							(canvas) => canvas.id === canvasId && canvas.kind === "image"
						)
					);
				});
				const persisted = fs.readFileSync(join(userData, "workspace", "canvases.json"), "utf8");
				assert.ok(persisted.includes(asset.id));
				assert.ok(persisted.includes(SHA));
				await js(
					`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Recent');if(!b)throw Error('Recent missing');b.click();})()`
				);
				await wait("Recent dialog", () => js(`!!document.querySelector('.canvas-history-list')`));
				await js(
					`(()=>{const b=[...document.querySelectorAll('.canvas-history-list button')].find(e=>e.textContent.includes(${JSON.stringify(TITLE)}));if(!b)throw Error('Saved image missing');b.click();})()`
				);
				await wait("reopened exact image acknowledged", async () => {
					const state = await js(DOM);
					const observation = await observe();
					return (
						observation.workspace.primaryId === canvasId &&
						state.images.some((image) => image.id === asset.id && image.sha === SHA) &&
						state.sequence === observation.workspace.sequence
					);
				});
				assertFrame(await js(DOM), asset);
				assert.equal(report.imageRequests.length, 1);
			}
		);
		await step(
			"foreground cancellation aborts actual provider HTTP and rejects any late canvas",
			async () => {
				const before = await observe();
				const count = report.ipc.filter((row) => row.path === "workspace.applied").length;
				const turn = await start("Generate cancelled image");
				await wait("actual held image HTTP request", () => cancellationEntered);
				await rpc("mutation", "conversation.cancel", {
					sessionId,
					turnId: turn.turnId,
					generation: turn.generation,
				});
				await wait("HTTP aborted by actual generation cancellation", () => cancellationClosed);
				cancelledResponse.response.end(JSON.stringify(cancelledResponse.result));
				for (let round = 0; round < 6; round++) {
					await pause(250);
					const after = await observe();
					assert.deepEqual(after.workspace.canvases, before.workspace.canvases);
					assert.equal(after.workspace.sequence, before.workspace.sequence);
				}
				assert.equal(report.ipc.filter((row) => row.path === "workspace.applied").length, count);
			}
		);
		await step(
			"missing Gemini key blocks only image generation and leaves ordinary conversation available",
			async () => {
				writeEnvironment(false);
				await rpc("mutation", "app.reloadConfig");
				const before = await observe();
				const calls = report.imageRequests.length;
				const missing = await start("Generate missing-key image");
				await settle(missing.turnId);
				assert.equal(report.imageRequests.length, calls);
				assert.deepEqual((await observe()).workspace.canvases, before.workspace.canvases);
				const ordinary = await start("Ordinary conversation after image failure");
				assert.equal((await settle(ordinary.turnId)).phase, "complete");
				const result = await rpc("query", "conversation.poll", {
					sessionId,
					turnId: ordinary.turnId,
					generation: ordinary.generation,
					afterSequence: 0,
					limit: 100,
				});
				assert.equal(result.text, "Ordinary conversation is still available.");
			}
		);
		assert.equal(report.serverError, undefined);
		assert.deepEqual(report.blocked, []);
		assert.deepEqual(report.permissions, []);
		fs.writeFileSync(
			join(out, "image-workspace-smoke.png"),
			(await win.webContents.capturePage()).toPNG()
		);
		await finish();
	} catch (error) {
		await finish(error);
	}
}
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	Promise.resolve()
		.then(() => (process.argv.includes("--self-check") ? support.selfCheck() : native()))
		.catch((error) => {
			console.error(error.stack ?? error.message);
			process.exitCode = 1;
		});
}
