import Link from "next/link";

import { PageHeading, PageNarrow } from "@/components/layout/page";
import { Button } from "@/components/ui/button";

export default function NotFound() {
    return (
        <PageNarrow className="flex flex-col items-center">
            <PageHeading>Nothing here</PageHeading>
            <Button asChild size="lg">
                <Link href="/">Markets</Link>
            </Button>
        </PageNarrow>
    );
}
