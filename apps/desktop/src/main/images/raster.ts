import { inflateSync } from "node:zlib";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export type Raster = {
	bytes: Buffer;
	mime: "image/png" | "image/jpeg";
	width: number;
	height: number;
};
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function dimensions(width: number, height: number) {
	if (!width || !height || width > 4096 || height > 4096)
		throw new Error("Invalid raster dimensions");
	return { width, height };
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	return value >>> 0;
});
function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}
/** Inspect actual bytes, never provider filenames/declared dimensions or remote URLs. */
export function inspectRaster(bytes: Buffer, mime: "image/png" | "image/jpeg"): Raster {
	if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES)
		throw new Error("Invalid raster byte count");
	if (mime === "image/png") {
		if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error("Invalid PNG signature");
		let offset = 8;
		let header: Buffer | undefined;
		let ended = false;
		let palette = false;
		const data: Buffer[] = [];
		while (offset + 12 <= bytes.length) {
			const length = bytes.readUInt32BE(offset);
			if (length > MAX_IMAGE_BYTES || offset + 12 + length > bytes.length)
				throw new Error("Invalid PNG chunk");
			const type = bytes.toString("ascii", offset + 4, offset + 8);
			const chunk = bytes.subarray(offset + 8, offset + 8 + length);
			if (
				crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
				bytes.readUInt32BE(offset + 8 + length)
			)
				throw new Error("Invalid PNG checksum");
			if (!header && type !== "IHDR") throw new Error("Missing PNG header");
			if (type === "IHDR") {
				if (header || length !== 13) throw new Error("Invalid PNG header");
				header = chunk;
			} else if (type === "IDAT") data.push(chunk);
			else if (type === "PLTE") palette = length > 0 && length % 3 === 0 && length <= 768;
			else if (type === "IEND") {
				if (length !== 0) throw new Error("Invalid PNG end");
				ended = true;
				offset += 12;
				break;
			} else if (/^[A-Z]/.test(type) || ["acTL", "fcTL", "fdAT"].includes(type))
				throw new Error("Unsupported PNG format");
			offset += length + 12;
		}
		if (!header || !ended || offset !== bytes.length || !data.length)
			throw new Error("Incomplete PNG");
		const { width, height } = dimensions(header.readUInt32BE(0), header.readUInt32BE(4));
		const depth = header[8] ?? 0;
		const color = header[9] ?? -1;
		const channels = new Map([
			[0, 1],
			[2, 3],
			[3, 1],
			[4, 2],
			[6, 4],
		]).get(color);
		if (
			!channels ||
			![1, 2, 4, 8, 16].includes(depth) ||
			([2, 4, 6].includes(color) && depth < 8) ||
			(color === 3 && (depth > 8 || !palette)) ||
			header[10] !== 0 ||
			header[11] !== 0 ||
			header[12] !== 0
		)
			throw new Error("Unsupported PNG encoding");
		const rowBytes = Math.ceil((width * channels * depth) / 8) + 1;
		const expected = rowBytes * height;
		const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
		if (pixels.length !== expected) throw new Error("Incomplete PNG pixels");
		for (let row = 0; row < height; row++)
			if ((pixels[row * rowBytes] ?? 5) > 4) throw new Error("Invalid PNG filter");
		return { bytes, mime, width, height };
	}
	if (
		bytes[0] !== 0xff ||
		bytes[1] !== 0xd8 ||
		bytes[bytes.length - 2] !== 0xff ||
		bytes[bytes.length - 1] !== 0xd9
	)
		throw new Error("Invalid JPEG signature");
	let offset = 2;
	let size: { width: number; height: number } | undefined;
	while (offset < bytes.length - 2) {
		if (bytes[offset++] !== 0xff) throw new Error("Invalid JPEG marker");
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (marker === undefined || marker === 0 || marker === 0xd9) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 2 > bytes.length) throw new Error("Incomplete JPEG marker");
		const length = bytes.readUInt16BE(offset);
		if (length < 2 || offset + length > bytes.length - 2) throw new Error("Invalid JPEG segment");
		if ([0xc0, 0xc1, 0xc2].includes(marker)) {
			if (size || length < 8 || bytes[offset + 2] !== 8) throw new Error("Unsupported JPEG frame");
			size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
		}
		if (marker === 0xda) {
			if (!size || offset + length >= bytes.length - 2) throw new Error("Missing JPEG pixels");
			return { bytes, mime, ...size };
		}
		offset += length;
	}
	throw new Error("Incomplete JPEG");
}
