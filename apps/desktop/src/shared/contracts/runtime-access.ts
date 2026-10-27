import { z } from "zod";
import { CommitShaSchema, IdSchema, RepositoryPathSchema, RevisionSchema } from "./common";

export const CredentialProviderSchema = z.enum(["github", "meta", "elevenlabs"]);
// Renderer status has no secret, encrypted value or credential getter.
export const CredentialStatusSchema = z.strictObject({
	provider: CredentialProviderSchema,
	configured: z.boolean(),
	storage: z.enum(["os-encrypted", "env-file"]),
});
export const CredentialStatusListSchema = z
	.array(CredentialStatusSchema)
	.max(CredentialProviderSchema.options.length)
	.refine(
		(rows) => new Set(rows.map((row) => row.provider)).size === rows.length,
		"Credential status providers must be unique"
	);

export const SetCredentialInputSchema = z.strictObject({
	provider: CredentialProviderSchema,
	// Match CredentialStore.set: bound the original input, then trim and reject blank values.
	secret: z.string().max(16_384).trim().min(1),
});
export const RemoveCredentialInputSchema = z.strictObject({
	provider: CredentialProviderSchema,
});

// Main resolves the PR's trusted prepared repository and pinned revision; callers supply no root/SHA.
export const SourceFileRequestSchema = z.strictObject({
	prId: IdSchema,
	revision: RevisionSchema,
	path: RepositoryPathSchema,
});
export const SourceFileSchema = z.strictObject({
	...SourceFileRequestSchema.shape,
	// Main populates these from the same prepared PR and requested revision.
	repository: IdSchema,
	commitSha: CommitShaSchema,
	// Full, untrimmed text preserves one-based lines, including leading/trailing blank lines.
	// Null means absent at this revision; read failures or truncated output must fail the request.
	// This bounds JS string length; main separately enforces its 1,000,000-byte process output cap.
	content: z.string().max(1_000_000).nullable(),
});

export type CredentialProvider = z.infer<typeof CredentialProviderSchema>;
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
export type CredentialStatusList = z.infer<typeof CredentialStatusListSchema>;
export type SetCredentialInput = z.infer<typeof SetCredentialInputSchema>;
export type RemoveCredentialInput = z.infer<typeof RemoveCredentialInputSchema>;
export type SourceFileRequest = z.infer<typeof SourceFileRequestSchema>;
export type SourceFile = z.infer<typeof SourceFileSchema>;
