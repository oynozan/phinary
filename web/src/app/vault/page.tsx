import type { Metadata } from "next";
import { PageHeading, PageNarrow } from "@/components/layout/page";
import { EmptyState } from "@/components/layout/panel";

export const metadata: Metadata = { title: "Vault" };
export default function Page() {
    return <PageNarrow><PageHeading>Vault</PageHeading><EmptyState title="Vault deposits and withdrawals are not connected yet." /></PageNarrow>;
}
