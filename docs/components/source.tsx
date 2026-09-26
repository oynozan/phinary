const REPO = "https://github.com/oynozan/phinary/blob/843c2d2b5c3ca51569e3a4fda2c70f5300774003";

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
