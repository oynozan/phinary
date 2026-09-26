import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
    reactCompiler: true,
    devIndicators: false,
    agentRules: false,
    transpilePackages: ["@phinary/swap-sdk"],
    turbopack: { root: path.resolve(__dirname, "..") },
};

export default nextConfig;
