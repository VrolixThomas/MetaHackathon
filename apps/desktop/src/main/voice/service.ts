import { type TurnIdentity, TurnIdentitySchema } from "../../shared/contracts";
import {
	type SpeakInput,
	SpeakSchema,
	VoiceAnswerSchema,
	type VoiceOffer,
	VoiceOfferSchema,
	type VoicePoll,
	VoicePollResultSchema,
	VoicePollSchema,
} from "./protocol";
import type { VoiceBackend } from "./sidecar";

interface Session {
	identity: TurnIdentity;
	cancelled: boolean;
	abort: AbortController;
	offerKey?: string;
	offer?: Promise<{ sdp: string; type: "answer" }>;
}
const same = (a: TurnIdentity, b: TurnIdentity) =>
	a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;

/** Main-side admission/tombstones complement the renderer and sidecar generation guards. */
export class VoiceService {
	private sessions = new Map<string, Session>();
	private disposed = false;
	private disposal?: Promise<void>;
	constructor(private backend: VoiceBackend) {}
	private assertLive() {
		if (this.disposed) throw new Error("Voice service is shut down");
	}
	private current(identity: TurnIdentity): Session {
		this.assertLive();
		const session = this.sessions.get(identity.sessionId);
		if (!session || session.cancelled || !same(session.identity, identity))
			throw new Error("Stale voice turn");
		return session;
	}
	private admit(identity: TurnIdentity): Session {
		this.assertLive();
		const previous = this.sessions.get(identity.sessionId);
		if (previous) {
			if (identity.generation <= previous.identity.generation)
				throw new Error("Stale voice generation");
			previous.cancelled = true;
			previous.abort.abort();
		} else if (this.sessions.size >= 128)
			throw new Error("Voice session limit reached; restart voice service");
		const session = {
			identity: TurnIdentitySchema.parse({
				sessionId: identity.sessionId,
				turnId: identity.turnId,
				generation: identity.generation,
			}),
			cancelled: false,
			abort: new AbortController(),
		};
		this.sessions.set(identity.sessionId, session);
		return session;
	}
	offer(raw: VoiceOffer): Promise<{ sdp: string; type: "answer" }> {
		const input = VoiceOfferSchema.parse(raw);
		const existing = this.sessions.get(input.sessionId);
		const key = JSON.stringify(input);
		if (
			existing &&
			!existing.cancelled &&
			same(existing.identity, input) &&
			existing.offerKey === key &&
			existing.offer
		)
			return existing.offer;
		const session = this.admit(input);
		session.offerKey = key;
		session.offer = this.backend
			.request("offer", input, session.abort.signal)
			.then((result) => {
				this.current(input);
				return VoiceAnswerSchema.parse(result);
			})
			.catch((error: unknown) => {
				session.cancelled = true;
				session.abort.abort();
				// Even a timed-out/aborted HTTP offer may have created a peer on the server.
				void this.backend.request("cancel", session.identity).catch(() => {});
				throw error;
			});
		return session.offer;
	}
	async release(raw: TurnIdentity): Promise<void> {
		const input = TurnIdentitySchema.parse(raw);
		const session = this.current(input);
		await this.backend.request("release", input, session.abort.signal);
		this.current(input);
	}
	async speak(raw: SpeakInput): Promise<void> {
		const input = SpeakSchema.parse(raw);
		const session = this.current(input);
		await this.backend.request("speak", input, session.abort.signal);
		this.current(input);
	}
	async poll(raw: VoicePoll) {
		const input = VoicePollSchema.parse(raw);
		const session = this.current(input);
		const result = VoicePollResultSchema.parse(
			await this.backend.request("poll", input, session.abort.signal)
		);
		this.current(input);
		let last = input.afterSequence;
		for (const event of result.events) {
			if (!same(event, input) || event.sequence <= last)
				throw new Error("Invalid voice event identity or sequence");
			last = event.sequence;
		}
		return result;
	}
	async cancel(raw: TurnIdentity): Promise<void> {
		const input = TurnIdentitySchema.parse(raw);
		this.assertLive();
		let session = this.sessions.get(input.sessionId);
		if (session && input.generation < session.identity.generation) return;
		if (
			session &&
			input.generation === session.identity.generation &&
			!same(session.identity, input)
		)
			return;
		if (!session || input.generation > session.identity.generation) session = this.admit(input);
		session.cancelled = true;
		session.abort.abort();
		await this.backend.request("cancel", input);
	}
	dispose(): Promise<void> {
		this.disposal ??= this.stop();
		return this.disposal;
	}
	private async stop() {
		if (this.disposed) return;
		this.disposed = true;
		for (const session of this.sessions.values()) {
			session.cancelled = true;
			session.abort.abort();
		}
		await this.backend.dispose();
		this.sessions.clear();
	}
}
