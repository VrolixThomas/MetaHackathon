import { TurnIdentitySchema } from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import {
	SpeakSchema,
	VoiceAnswerSchema,
	VoiceOfferSchema,
	VoicePollResultSchema,
	VoicePollSchema,
} from "./protocol";
import type { VoiceService } from "./service";
export function createVoiceRouter(service: VoiceService) {
	return router({
		offer: publicProcedure
			.input(VoiceOfferSchema)
			.output(VoiceAnswerSchema)
			.mutation(({ input }) => service.offer(input)),
		release: publicProcedure
			.input(TurnIdentitySchema)
			.mutation(({ input }) => service.release(input)),
		speak: publicProcedure.input(SpeakSchema).mutation(({ input }) => service.speak(input)),
		cancel: publicProcedure
			.input(TurnIdentitySchema)
			.mutation(({ input }) => service.cancel(input)),
		poll: publicProcedure
			.input(VoicePollSchema)
			.output(VoicePollResultSchema)
			.query(({ input }) => service.poll(input)),
	});
}
