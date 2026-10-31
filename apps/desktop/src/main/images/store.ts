import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type ImageAsset, ImageAssetSchema, ImageReadResultSchema } from "../../shared/contracts";
import { throwIfAborted } from "../agent/cancellation";
import { ImageError } from "./gemini";
import { MAX_IMAGE_BYTES, type Raster, inspectRaster } from "./raster";

const idSchema = z.string().regex(/^image-[a-f0-9]{64}$/);
const recordSchema = z.strictObject({
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	status: z.enum(["pending", "failed", "complete"]),
	asset: ImageAssetSchema.optional(),
});
type Record = z.infer<typeof recordSchema>;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** App-owned private files only. IDs are opaque; paths never cross the service boundary. */
export class PrivateImageStore {
	private readonly ready: Promise<void>;
	private admission = Promise.resolve();
	constructor(
		private readonly directory: string,
		private readonly capacity = 256
	) {
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
			throw new ImageError("image-capacity");
		this.ready = (async () => {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const stat = await lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ImageError("image-unavailable");
			await chmod(directory, 0o700);
		})();
		void this.ready.catch(() => {});
	}
	id(requestId: string) {
		return `image-${sha(requestId)}`;
	}
	private async readBytes(path: string, max: number) {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size <= 0 || stat.size > max)
				throw new ImageError("image-unavailable");
			// A concurrent local edit cannot grow an allocation beyond the admitted byte bound.
			const bytes = Buffer.alloc(stat.size);
			let offset = 0;
			while (offset < bytes.length) {
				const result = await file.read(bytes, offset, bytes.length - offset, offset);
				if (!result.bytesRead) throw new ImageError("image-unavailable");
				offset += result.bytesRead;
			}
			if ((await file.stat()).size !== bytes.length) throw new ImageError("image-unavailable");
			return bytes;
		} finally {
			await file.close();
		}
	}
	private async record(id: string) {
		idSchema.parse(id);
		return recordSchema.parse(
			JSON.parse(
				(await this.readBytes(join(this.directory, `${id}.json`), 16_000)).toString("utf8")
			)
		);
	}
	private async atomic(path: string, bytes: string | Buffer) {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(bytes);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}
	async admit(
		requestId: string,
		fingerprint: string,
		signal: AbortSignal
	): Promise<ImageAsset | null> {
		const result = this.admission.then(() => this.admitOne(requestId, fingerprint, signal));
		this.admission = result.then(
			() => {},
			() => {}
		);
		return result;
	}
	private async admitOne(
		requestId: string,
		fingerprint: string,
		signal: AbortSignal
	): Promise<ImageAsset | null> {
		await this.ready;
		throwIfAborted(signal);
		const id = this.id(requestId);
		try {
			const previous = await this.record(id);
			if (previous.fingerprint !== fingerprint || previous.status !== "complete" || !previous.asset)
				throw new ImageError("image-request-conflict");
			return (await this.read(id, signal)).asset;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw error instanceof ImageError ? error : new ImageError("image-unavailable");
		}
		const records = (await readdir(this.directory)).filter((name) =>
			/^image-[a-f0-9]{64}\.json$/.test(name)
		);
		if (records.length >= this.capacity) throw new ImageError("image-capacity");
		throwIfAborted(signal);
		const file = await open(join(this.directory, `${id}.json`), "wx", 0o600).catch(() => {
			throw new ImageError("image-request-conflict");
		});
		try {
			await file.writeFile(JSON.stringify(recordSchema.parse({ fingerprint, status: "pending" })));
			await file.sync();
		} finally {
			await file.close();
		}
		return null;
	}
	async save(
		input: {
			requestId: string;
			fingerprint: string;
			title: string;
			provider: string;
			model: string;
		},
		raw: Raster,
		signal: AbortSignal
	): Promise<ImageAsset> {
		await this.ready;
		throwIfAborted(signal);
		const id = this.id(input.requestId);
		const pending = await this.record(id);
		if (pending.fingerprint !== input.fingerprint || pending.status !== "pending")
			throw new ImageError("image-request-conflict");
		const raster = inspectRaster(raw.bytes, raw.mime);
		const asset = ImageAssetSchema.parse({
			id,
			title: input.title,
			mime: raster.mime,
			width: raster.width,
			height: raster.height,
			sha256: sha(raster.bytes),
			byteLength: raster.bytes.length,
			createdAt: new Date().toISOString(),
			provenance: "provider-generated",
			provider: input.provider,
			model: input.model,
		});
		const path = join(this.directory, `${id}.${asset.mime === "image/png" ? "png" : "jpg"}`);
		await this.atomic(path, raster.bytes);
		if (signal.aborted) {
			await unlink(path).catch(() => {});
			throwIfAborted(signal);
		}
		await this.atomic(
			join(this.directory, `${id}.json`),
			JSON.stringify({ fingerprint: input.fingerprint, status: "complete", asset } satisfies Record)
		);
		throwIfAborted(signal);
		return structuredClone(asset);
	}
	async fail(requestId: string, fingerprint: string) {
		try {
			await this.ready;
			const id = this.id(requestId);
			const current = await this.record(id);
			if (current.status === "pending" && current.fingerprint === fingerprint)
				await this.atomic(
					join(this.directory, `${id}.json`),
					JSON.stringify({ fingerprint, status: "failed" } satisfies Record)
				);
		} catch {
			/* Preserve the original bounded service error; never report success. */
		}
	}
	async read(id: string, signal?: AbortSignal) {
		try {
			await this.ready;
			if (signal) throwIfAborted(signal);
			const record = await this.record(id);
			const asset = record.asset;
			if (record.status !== "complete" || !asset || asset.id !== id)
				throw new ImageError("image-unavailable");
			const bytes = await this.readBytes(
				join(this.directory, `${id}.${asset.mime === "image/png" ? "png" : "jpg"}`),
				MAX_IMAGE_BYTES
			);
			const raster = inspectRaster(bytes, asset.mime);
			if (
				bytes.length !== asset.byteLength ||
				sha(bytes) !== asset.sha256 ||
				raster.width !== asset.width ||
				raster.height !== asset.height
			)
				throw new ImageError("image-unavailable");
			if (signal) throwIfAborted(signal);
			return ImageReadResultSchema.parse({
				asset,
				dataUrl: `data:${asset.mime};base64,${bytes.toString("base64")}`,
			});
		} catch (error) {
			if (signal) throwIfAborted(signal);
			throw error instanceof ImageError ? error : new ImageError("image-unavailable");
		}
	}
}
