import { parseActivity } from "@/lib/activity/client";
import deployment from "../../../../../deployments/unichain-sepolia.json";
export const dynamic = "force-dynamic";
export async function GET() {
    // Server-side only: browsers never need indexer credentials or CORS access.
    const endpoint = process.env.PHINARY_INDEXER_URL || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:42069" : "");
    if (!endpoint) return Response.json({ error: "Activity indexer not configured" }, { status: 503 });
    try {
        const url = new URL(endpoint);
        if (!["http:", "https:"].includes(url.protocol)) throw Error("Invalid indexer URL");
        url.pathname = `${url.pathname.replace(/\/$/, "")}/activity`;
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw Error("Indexer unavailable");
        const data = await response.json();
        if (data.version !== 1 || data.chainId !== deployment.chainId || data.hook?.toLowerCase() !== deployment.predictionHook.toLowerCase()) throw Error("Wrong deployment");
        const snapshot = parseActivity(data.snapshot);
        return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    } catch { return Response.json({ error: "Activity temporarily unavailable" }, { status: 503 }); }
}
