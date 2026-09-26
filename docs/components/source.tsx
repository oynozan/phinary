const REPO = "https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208";

/** GitHub permalink to a repo file, shown as `File.sol:12-34` */
export function Source({ path, lines }: { path: string; lines?: string }) {
    const [from, to] = lines ? lines.split("-") : [];
    const anchor = from ? `#L${from}${to ? `-L${to}` : ""}` : "";
    const file = path.split("/").pop();
    return (
        <a className="source-link" href={`${REPO}/${path}${anchor}`} target="_blank" rel="noreferrer">
            {lines ? `${file}:${lines}` : path}
        </a>
    );
}
