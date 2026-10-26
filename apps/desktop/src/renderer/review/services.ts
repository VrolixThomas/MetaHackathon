import { create } from "zustand";

export type CredentialProvider = "meta" | "elevenlabs" | "github";
export type CredentialStatus = {
	provider: CredentialProvider;
	configured: boolean;
	storage: string;
};
/** Runtime composition port: deliberately exposes no key getter. */
export type SettingsAdapter = {
	status: () => Promise<CredentialStatus[]>;
	set: (provider: CredentialProvider, value: string) => Promise<void>;
	remove: (provider: CredentialProvider) => Promise<void>;
	signInGitHub: () => Promise<void>;
};
export type VoiceAdapter = {
	beginCapture: () => void | Promise<void>;
	endCapture: () => void | Promise<void>;
	interrupt: () => void | Promise<void>;
	getPhase: () => string;
	subscribe: (listener: () => void) => () => void;
};
export const useServices = create<{ settings: SettingsAdapter | null; voice: VoiceAdapter | null }>(
	() => ({ settings: null, voice: null })
);
export function configureReviewServices(
	services: Partial<ReturnType<typeof useServices.getState>>
) {
	useServices.setState(services);
}
