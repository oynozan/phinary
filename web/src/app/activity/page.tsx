import type { Metadata } from "next";
import { PageHeading, PageNarrow } from "@/components/layout/page";
import { EmptyState } from "@/components/layout/panel";

export const metadata: Metadata = { title: "Activity" };
export default function Page() {
    return <PageNarrow><PageHeading>Activity</PageHeading><EmptyState title="Trade history is not connected yet." /></PageNarrow>;
}
