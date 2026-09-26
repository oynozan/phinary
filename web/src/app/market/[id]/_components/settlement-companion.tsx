import Image from "next/image";
import Link from "next/link";

/** A quiet next step after resolution, without suggesting a trade or outcome. */
export function SettlementCompanion() {
    return <aside className="detail-companion" aria-label="Explore more markets">
        <Image src="/markets/orbital-companion.webp" width={640} height={640} sizes="(max-width: 639px) 112px, 260px" alt="" />
        <div><h2>What’s next?</h2><p>There’s more to explore.</p><Link href="/">Explore markets</Link></div>
    </aside>;
}
