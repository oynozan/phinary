import type { NextConfig } from "next";
import nextra from "nextra";

const withNextra = nextra({ latex: true });

const nextConfig: NextConfig = {
    reactCompiler: true,
    devIndicators: false,
};

export default withNextra(nextConfig);
