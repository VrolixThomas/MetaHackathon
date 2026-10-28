import type { TurnIdentity } from "../../shared/contracts";
import { asError } from "./async";
import type { VoiceTurnEnd } from "./types";

type FailedTurn = Extract<VoiceTurnEnd, { status: "failed" }>;
type FailureReport = TurnIdentity & Pick<FailedTurn, "origin" | "recoverable">;
const reports = new WeakMap<Error, FailureReport>();

/** Internal provenance: messages (including provider diagnostics) never classify a failure. */
export class VoiceFailure {
	constructor(
		readonly origin: FailedTurn["origin"],
		readonly error: Error
	) {}
}

export async function fromOrigin<T>(origin: FailedTurn["origin"], work: () => Promise<T>) {
	try {
		return await work();
	} catch (error) {
		throw error instanceof VoiceFailure ? error : new VoiceFailure(origin, asError(error));
	}
}

/** Scope provenance to this synchronous report, preserving the original Error and its class. */
export function reportTurnFailure(error: Error, failure: FailureReport, report: () => void) {
	const previous = reports.get(error);
	reports.set(error, failure);
	try {
		report();
	} finally {
		if (previous) reports.set(error, previous);
		else reports.delete(error);
	}
}

export const getTurnFailureReport = (error: Error) => reports.get(error);
