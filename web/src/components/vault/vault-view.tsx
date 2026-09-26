"use client";

import { useMarkets, useVault, useWallet } from "@/lib/data";

import { RiskTable } from "./risk-table";
import { VaultCard } from "./vault-card";
import { VaultHeading, VaultStats } from "./vault-summary";

export function VaultView() {
    const vault = useVault();
    const wallet = useWallet();
    const markets = useMarkets();
    const byId = markets.data ? new Map(markets.data.map((m) => [m.id, m])) : null;
    const connected = !wallet.isLoading && wallet.isConnected;

    return (
        <>
            <VaultHeading vault={vault.data} />
            <VaultCard vault={vault.data} wallet={wallet} />
            <VaultStats vault={vault.data} connected={connected} className="mt-12" />
            <RiskTable risks={vault.data?.markets} markets={byId} className="mt-12" />
        </>
    );
}
