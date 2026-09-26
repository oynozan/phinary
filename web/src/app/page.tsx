import { MarketsHome } from "@/components/home/markets-home";
import { Accent, HeroHeading, PageWide } from "@/components/layout/page";

export default function MarketsPage() {
    return (
        <PageWide>
            <HeroHeading>
                Predict <Accent>ETH</Accent> every minute
            </HeroHeading>
            <MarketsHome />
        </PageWide>
    );
}
