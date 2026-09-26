import type { Metadata } from "next";
import { PageHeading, PageNarrow } from "@/components/layout/page";
import { EmptyState } from "@/components/layout/panel";

export const metadata: Metadata = { title: "Portfolio" };
export default function Page() {
    return <PageNarrow><PageHeading>Portfolio</PageHeading><EmptyState title="Portfolio is not connected yet. View your UP balance on the market page." /></PageNarrow>;
}
