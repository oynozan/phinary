"use client";

import { useMemo, useSyncExternalStore } from "react";
import { erc20Abi, type Address } from "viem";
import { createResource } from "../data/resource.ts";
import { createChainClient } from "./client.ts";
import { useWalletSession } from "./wallet.ts";
import { getConnectionConfig } from "./config.ts";

export function useTokenBalance(token: Address) {
    const session = useWalletSession();
    const account = session.address;
    const chainId = session.chainId;
    const resource = useMemo(() => createResource(async () => {
        if (!account || chainId !== getConnectionConfig().chainId) return null;
        return createChainClient().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    }), [token, account, chainId]);
    const query = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
    return { ...query, refresh: resource.refresh };
}
