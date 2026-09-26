import type { Metadata } from "next";

import { PageNarrow } from "@/components/layout/page";
import { VaultView } from "@/components/vault/vault-view";

export const metadata: Metadata = { title: "Vault" };

export default function VaultPage() {
    return (
        <PageNarrow size="sm">
            <VaultView />
        </PageNarrow>
    );
}
