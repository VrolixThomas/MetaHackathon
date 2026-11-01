import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

const geist = localFont({
	src: [
		{ path: "./fonts/geist-regular.woff2", weight: "400" },
		{ path: "./fonts/geist-semibold.woff2", weight: "500 900" },
	],
	variable: "--font-geist",
	display: "swap",
});
const mono = localFont({
	src: "./fonts/geist-mono.woff2",
	variable: "--font-geist-mono",
	display: "swap",
});
const siteUrl = process.env["WEBSITE_SITE_URL"] ?? "http://localhost:3000";
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: "#050507",
	colorScheme: "dark",
};
export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title: "MuseFocus — Let work flow. Keep your focus.",
	description:
		"Connect GitHub, Linear and Slack. Plan, build, review and follow up through one ongoing conversation, with the right thing in focus.",
	applicationName: "MuseFocus",
	icons: {
		icon: [
			{ url: "/favicon.svg", type: "image/svg+xml" },
			{ url: "/favicon.ico", sizes: "any" },
		],
		apple: "/apple-touch-icon.png",
	},
	openGraph: {
		title: "MuseFocus — Let work flow. Keep your focus.",
		description: "Background work. Foreground clarity. Your attention, well spent.",
		type: "website",
		images: [
			{
				url: "/og-image.png",
				width: 1200,
				height: 630,
				alt: "MuseFocus — Let work flow. Keep your focus.",
			},
		],
	},
	twitter: { card: "summary_large_image" },
};
export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={`${geist.variable} ${mono.variable}`}>
			<body>{children}</body>
		</html>
	);
}
