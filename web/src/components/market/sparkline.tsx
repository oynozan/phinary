import { cn } from "@/lib/utils";

/**
 * Tiny line for cards. Values are plotted on a fixed domain (default 0..1, a probability),
 * so two sparklines are comparable. Stretches to its container.
 */
export function Sparkline({
    data,
    domain = [0, 1],
    color = "var(--up)",
    className,
}: {
    data: number[];
    domain?: [number, number];
    color?: string;
    className?: string;
}) {
    const [lo, hi] = domain;
    const span = hi - lo || 1;
    const n = data.length;
    const pts = data.map((v, i) => {
        const x = n > 1 ? (i / (n - 1)) * 100 : 50;
        const y = 30 - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * 28 - 1;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const line = pts.length ? `M${pts.join("L")}` : "";
    const area = pts.length ? `${line}L100,30L0,30Z` : "";
    return (
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden className={cn("h-10 w-full overflow-visible", className)}>
            <line x1="0" x2="100" y1="15" y2="15" stroke="currentColor" strokeOpacity="0.12" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            {n > 1 && (
                <>
                    <path d={area} fill={color} fillOpacity="0.08" />
                    <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </>
            )}
        </svg>
    );
}
