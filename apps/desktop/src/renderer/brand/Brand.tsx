import { PRODUCT_NAME } from "../../shared/brand";
import "./brand.css";

// Vite emits hashed, relative URLs for both development and packaged file loading.
// Each size uses the final kit's optically simplified micro artwork, unchanged.
const marks = {
	16: new URL("./assets/pull-forward-16.svg", import.meta.url).href,
	20: new URL("./assets/pull-forward-20.svg", import.meta.url).href,
	24: new URL("./assets/pull-forward-24.svg", import.meta.url).href,
	32: new URL("./assets/pull-forward-32.svg", import.meta.url).href,
	48: new URL("./assets/pull-forward-48.svg", import.meta.url).href,
	64: new URL("./assets/pull-forward-64.svg", import.meta.url).href,
};

export function BrandMark({ size = 24 }: { size?: keyof typeof marks }) {
	return (
		<img
			className="musefocus-mark"
			src={marks[size]}
			width={size}
			height={size}
			alt=""
			aria-hidden="true"
			draggable={false}
		/>
	);
}

export function BrandLockup({ size = 24 }: { size?: keyof typeof marks }) {
	return (
		<span className="musefocus-lockup">
			<BrandMark size={size} />
			<span>{PRODUCT_NAME}</span>
		</span>
	);
}
