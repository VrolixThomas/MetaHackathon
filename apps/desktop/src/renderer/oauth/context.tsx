import { type ReactNode, createContext, useContext } from "react";
import type { OAuthController } from "./controller";

const OAuthContext = createContext<OAuthController | null>(null);

/** The root starts/disposes the shared controller; mounting a widget never starts login. */
export function OAuthProvider({
	controller,
	children,
}: { controller: OAuthController; children: ReactNode }) {
	return <OAuthContext.Provider value={controller}>{children}</OAuthContext.Provider>;
}

export function useOAuth(): OAuthController | null {
	return useContext(OAuthContext);
}
