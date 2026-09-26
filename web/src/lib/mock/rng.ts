/** Deterministic 32-bit hash of integers (splitmix-style mixing). */
export function hash32(...parts: number[]): number {
    let h = 0x9e3779b9;
    for (const p of parts) {
        h ^= Math.floor(p) | 0;
        h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        h ^= h >>> 16;
    }
    return h >>> 0;
}

/** Uniform [0, 1) from integers. */
export function rand01(...parts: number[]): number {
    return hash32(...parts) / 4294967296;
}

/** Standard normal from integers (Box-Muller). */
export function randNormal(...parts: number[]): number {
    const u = Math.max(rand01(...parts, 1), 1e-12);
    const v = rand01(...parts, 2);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic 20-byte address from integers. */
export function mockAddress(...parts: number[]): `0x${string}` {
    let out = "";
    for (let i = 0; i < 5; i++) out += hash32(...parts, i).toString(16).padStart(8, "0");
    return `0x${out}`;
}

export function mockHash(...parts: number[]): `0x${string}` {
    let out = "";
    for (let i = 0; i < 8; i++) out += hash32(...parts, 100 + i).toString(16).padStart(8, "0");
    return `0x${out}`;
}
