import { DotGrid } from "@/components/backgrounds/dot-grid";
import { MarketsHome } from "@/components/home/markets-home";
import { Accent, HeroHeading, PageWide } from "@/components/layout/page";

export default function MarketsPage() {
    return (
        <>
            <DotGrid />
            <PageWide>
                <HeroHeading className="mb-4 lg:mb-5">
                    Predict ETH on <Accent>Uniswap</Accent>
                </HeroHeading>
                <p className="mb-6 text-center font-secondary text-base font-semibold text-muted-foreground sm:text-lg lg:mb-8">
                    ETH prediction markets on Uniswap v4.
                </p>
                <MarketsHome />
            </PageWide>
        </>
    );
}
