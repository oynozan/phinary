"use client";

import Image from "next/image";
import "./wallet-dialog.css";
import { useEffect, type ReactNode } from "react";
import { PrivyProvider, useConnectWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { unichainSepolia } from "viem/chains";
import { toast } from "sonner";
import { adoptPrivyWallet, clearWalletSession, registerWalletConnection } from "@/lib/onchain/wallet";
import type { BrowserProvider } from "@/lib/onchain/wallet-core";

function WalletBridge() {
    const { ready } = usePrivy();
    const { wallets, ready: walletsReady } = useWallets();
    const wallet = wallets[0];
    const { connectWallet } = useConnectWallet();
    useEffect(() => {
        if (!ready || !walletsReady) return;
        return registerWalletConnection(id => connectWallet({
            walletChainType: "ethereum-only",
            walletList: id === "io.metamask" ? ["metamask"] : undefined,
            description: <span className="phinary-privy-intro">
                <Image src="/wallets/phinary.svg" alt="" width={112} height={112} />
                <span className="phinary-privy-title" role="heading" aria-level={2}>Connect to Phinary</span>
                <span className="phinary-privy-description">Choose a wallet to continue.</span>
            </span>,
        }));
    }, [ready, walletsReady, connectWallet]);
    useEffect(() => {
        if (!walletsReady) return;
        if (!wallet) { clearWalletSession(); return; }
        let cancelled = false;
        void wallet.getEthereumProvider().then(provider => {
            if (!cancelled) return adoptPrivyWallet({
                id: wallet.walletClientType, name: wallet.meta.name,
                provider: provider as BrowserProvider,
            }, async () => { wallet.disconnect(); });
        }).catch(() => {
            if (!cancelled) { clearWalletSession(); toast.error("Could not read the connected wallet. Please reconnect."); }
        });
        return () => { cancelled = true; };
    }, [wallet, walletsReady]);
    return null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
    return <PrivyProvider
        appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmn3ifvlr00850ci8i01o5rld"}
        clientId={process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || "client-WY6XbQpSPtSBUpScwGtBhFkNDrHTSTa7Wh5YeqFMCiLWc"}
        config={{
            appearance: { theme: "#101012", accentColor: "#bd35f0", walletChainType: "ethereum-only", walletList: ["metamask", "detected_ethereum_wallets", "wallet_connect_qr"], landingHeader: "Connect to Phinary", logo: "/wallets/phinary.svg" },
            loginMethods: ["wallet"],
            defaultChain: unichainSepolia,
            supportedChains: [unichainSepolia],
            embeddedWallets: { ethereum: { createOnLogin: "off" } },
        }}>
        <WalletBridge />
        {children}
    </PrivyProvider>;
}
