/** Development-only isolated preview. No application API, wallet provider or RPC. */
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "node_modules/.cache/portfolio-preview");
await mkdir(output, { recursive: true });
const bundled = await build({ absWorkingDir: root, entryPoints: ["preview/portfolio/entry.tsx"], outdir: output, bundle: true, external: ["/markets/*"], format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, metafile: true });
const forbidden = Object.keys(bundled.metafile.inputs).filter((p) => /lib\/(onchain|mock|data)\//.test(p));
if (forbidden.length) throw Error(`Preview must not import live data or wallet code: ${forbidden.join(", ")}`);
let fonts = "";
const fontFiles = new Map<string, string>();
for (const directory of [join(root, ".next/dev/static"), join(root, ".next/static")]) {
    let files: string[] = [];
    try { files = await readdir(directory, { recursive: true }); } catch { continue; }
    for (const file of files.filter((f) => f.endsWith(".css"))) {
        const css = await readFile(join(directory, file), "utf8");
        for (const block of css.match(/@font-face\s*\{[^}]*font-family:\s*["']?Manrope["']?;[^}]*\}/g) ?? []) fonts += block.replace(/url\(["']?[^)"']*\/([^/)"']+)["']?\)/g, (_match, name) => `url("/fonts/${name}")`) + "\n";
    }
    for (const file of files.filter((f) => f.endsWith(".woff2"))) fontFiles.set(basename(file), join(directory, file));
}
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phinary Portfolio · UI preview</title><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>';
const server = createServer(async (req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1:3102").pathname;
    res.setHeader("Cache-Control", "no-store");
    try {
        if (route === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }
        else if (route === "/fonts.css") { res.setHeader("Content-Type", "text/css"); res.end(fonts); }
        else if (route === "/entry.js" || route === "/entry.css") { res.setHeader("Content-Type", route.endsWith("js") ? "text/javascript" : "text/css"); res.end(await readFile(join(output, route.slice(1)))); }
        else if (route === "/markets/orbit.webp") { res.setHeader("Content-Type", "image/webp"); res.end(await readFile(join(root, "public/markets/orbit.webp"))); }
        else if (route.startsWith("/fonts/") && fontFiles.has(route.slice(7))) { res.setHeader("Content-Type", "font/woff2"); res.end(await readFile(fontFiles.get(route.slice(7))!)); }
        else { res.statusCode = 404; res.end("Not found"); }
    } catch { res.statusCode = 500; res.end("Preview asset unavailable"); }
});
server.listen(3102, "127.0.0.1", () => console.log("Portfolio UI preview: http://localhost:3102 (sample data, no transactions)"));
