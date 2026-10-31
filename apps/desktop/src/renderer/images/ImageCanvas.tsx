import { useEffect, useMemo, useRef, useState } from "react";
import { type ImageAsset, ImageAssetSchema } from "../../shared/contracts";
import { type ImageReader, loadImageAsset, waitForImagePresentation } from "./controller";
import "./images.css";

/** Root mounts this for an authorized image canvas and waits for readiness before its receipt. */
export function ImageCanvas({
	asset: rawAsset,
	read,
	onReady,
}: {
	asset: ImageAsset;
	read: ImageReader;
	onReady?: (asset: ImageAsset, ready: boolean) => void;
}) {
	const identity = JSON.stringify(rawAsset);
	const asset = useMemo(() => ImageAssetSchema.parse(JSON.parse(identity)), [identity]);
	const key = identity;
	const [state, setState] = useState<{
		key: string;
		src: string | null;
		ready: boolean;
		error: boolean;
	}>({ key, src: null, ready: false, error: false });
	const active = useRef<{ key: string; abort: AbortController } | null>(null);
	const readyCallback = useRef(onReady);
	readyCallback.current = onReady;
	useEffect(() => {
		const abort = new AbortController();
		active.current = { key, abort };
		setState({ key, src: null, ready: false, error: false });
		readyCallback.current?.(asset, false);
		void loadImageAsset(asset, read, abort.signal).then(
			(result) => {
				if (!abort.signal.aborted)
					setState({ key, src: result.dataUrl, ready: false, error: false });
			},
			() => {
				if (!abort.signal.aborted) setState({ key, src: null, ready: false, error: true });
			}
		);
		return () => {
			abort.abort();
			readyCallback.current?.(asset, false);
		};
	}, [asset, key, read]);
	const current = state.key === key ? state : { key, src: null, ready: false, error: false };
	return (
		<figure
			className="image-canvas"
			data-image-asset-id={current.ready ? asset.id : undefined}
			data-image-sha256={current.ready ? asset.sha256 : undefined}
			data-image-ready={current.ready ? "true" : "false"}
		>
			{current.error ? (
				<p role="alert">This private image could not be loaded.</p>
			) : current.src ? (
				<img
					src={current.src}
					alt={asset.title}
					width={asset.width}
					height={asset.height}
					onLoad={(event) => {
						const image = event.currentTarget;
						const operation = active.current;
						if (!operation || operation.key !== key || operation.abort.signal.aborted) return;
						const abort = operation.abort;
						void waitForImagePresentation(image, asset, abort.signal).then((ready) => {
							if (abort.signal.aborted || active.current !== operation) return;
							setState((previous) =>
								previous.key === key ? { ...previous, ready, error: !ready } : previous
							);
							readyCallback.current?.(asset, ready);
						});
					}}
					onError={() => {
						if (active.current?.key !== key || active.current.abort.signal.aborted) return;
						setState((previous) =>
							previous.key === key ? { ...previous, ready: false, error: true } : previous
						);
						readyCallback.current?.(asset, false);
					}}
				/>
			) : (
				<output>Loading image…</output>
			)}
			<figcaption>{asset.title} · Generated image</figcaption>
		</figure>
	);
}
