import { z } from "zod";

export const WorkspaceUrlSchema = z
	.url()
	.max(4096)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				!url.username &&
				!url.password &&
				(url.protocol === "https:" ||
					(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
			);
		} catch {
			return false;
		}
	}, "Use HTTPS or a local HTTP address without credentials");
