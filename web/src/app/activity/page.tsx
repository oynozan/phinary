import type { Metadata } from "next";

import { ActivityView } from "@/components/activity/activity-view";
import { PageHeading, PageWide } from "@/components/layout/page";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
    return (
        <PageWide>
            <PageHeading>Activity</PageHeading>
            <ActivityView />
        </PageWide>
    );
}
