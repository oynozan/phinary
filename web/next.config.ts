import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
    distDir: process.env.PHINARY_E2E === "1" ? ".next-e2e" : ".next",
    reactCompiler: true,
    devIndicators: false,
    agentRules: false,
    transpilePackages: ["@phinary/swap-sdk"],
    turbopack: { root: path.resolve(__dirname, "..") },
};

export default nextConfig;
