import { createServer } from "node:http";
import { TeamError } from "../../../../../services/team/protocol";
import type { TeamAuth } from "./auth";

/** Temporary numeric loopback receiver; root injects shell.openExternal, never renderer-controlled URL. */
export class TeamLogin {
	private cancel: (() => void) | null = null;
	constructor(
		private readonly auth: TeamAuth,
		private readonly openExternal: (url: string) => Promise<void>,
		private readonly port = 43189
	) {}
	connect(signal?: AbortSignal): Promise<{ userId: string }> {
		this.cancel?.();
		return new Promise((resolve, reject) => {
			let redirect: string | null = null;
			let consumed = false;
			let settled = false;
			const server = createServer(async (req, res) => {
				let url: URL;
				try {
					url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
				} catch {
					res.writeHead(400);
					res.end();
					return;
				}
				if (
					req.method !== "GET" ||
					req.headers.host !== `127.0.0.1:${this.port}` ||
					!redirect ||
					`${url.origin}${url.pathname}` !== redirect ||
					(req.url?.length ?? 0) > 8000 ||
					consumed
				) {
					res.writeHead(404);
					res.end();
					return;
				}
				consumed = true;
				try {
					const result = await this.auth.finishLogin(url.toString());
					res.writeHead(200, {
						"Content-Type": "text/plain; charset=utf-8",
						"Cache-Control": "no-store",
					});
					res.end("Muse connected. You can close this tab.");
					finish();
					resolve(result);
				} catch {
					res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
					res.end("Muse sign-in failed. Start again in the app.");
					finish();
					reject(new TeamError("unauthorized"));
				}
			});
			const cancel = () => {
				if (settled) return;
				this.auth.cancelLogin();
				finish(true);
				reject(new TeamError("unauthorized"));
			};
			const finish = (abort = false) => {
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				server.close();
				if (abort) server.closeAllConnections();

				if (this.cancel === cancel) this.cancel = null;
			};
			const timer = setTimeout(cancel, 300000);
			timer.unref();
			this.cancel = cancel;
			if (signal?.aborted) {
				cancel();
				return;
			}
			signal?.addEventListener("abort", cancel, { once: true });
			server.requestTimeout = 15000;
			server.headersTimeout = 5000;
			server.maxHeadersCount = 16;
			server.once("error", () => {
				finish();
				reject(new TeamError("unavailable"));
			});
			server.listen(this.port, "127.0.0.1", () => {
				try {
					const authorize = this.auth.beginLogin(`http://127.0.0.1:${this.port}`);
					redirect = new URL(authorize).searchParams.get("redirect_to");
					void this.openExternal(authorize).catch(cancel);
				} catch {
					cancel();
				}
			});
		});
	}
	dispose() {
		this.cancel?.();
		this.cancel = null;
	}
}
