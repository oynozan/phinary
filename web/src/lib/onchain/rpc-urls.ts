/** A comma-separated RPC list, in order: the first URL is primary and the rest are fallbacks. */
export function rpcUrlList(value: string): string[] {
    const urls = value.split(",").map((url) => url.trim()).filter(Boolean);
    if (!urls.length) throw new Error("RPC URL is missing");
    for (const url of urls) if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("RPC must use HTTP or HTTPS");
    return urls;
}
