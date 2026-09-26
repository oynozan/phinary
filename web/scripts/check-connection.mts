/** Run after npm run dev:onchain. This exercises the actual Next.js SDK bundle. */
const url = new URL("/api/dev/connection", process.env.PHINARY_DEV_URL || "http://127.0.0.1:3101");
try {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    const report = await response.json();
    console.log(JSON.stringify(report, null, 2));
    if (!response.ok) process.exitCode = 1;
} catch {
    console.error("Connection check unavailable. Start npm run dev:onchain, then retry.");
    process.exitCode = 1;
}
