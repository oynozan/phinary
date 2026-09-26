import { checkConnection } from "@/lib/onchain/check-connection";

/** Development diagnostic only; trading will read the chain directly. */
export async function GET() {
    if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
    try {
        return Response.json(await checkConnection(), { headers: { "Cache-Control": "no-store" } });
    } catch {
        return Response.json({ error: "Connection check failed. Check RPC access, deployment and ABI compatibility." }, {
            status: 503, headers: { "Cache-Control": "no-store" },
        });
    }
}
