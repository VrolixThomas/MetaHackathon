import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	poweredByHeader: false,
	// Local vector/raster artwork is already exported at its intended resolution.
	images: { unoptimized: true },
};

export default nextConfig;
