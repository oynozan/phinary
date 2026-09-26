import { parseUnits } from "viem";
export type VaultMode = "deposit" | "withdraw";
export interface VaultAmounts {
    idle: bigint;
    navPlus: bigint;
    navMinus: bigint;
    totalShares: bigint;
    userShares: bigint;
    usdc: bigint;
}
export const SHARE_DECIMALS = 12;
export const SHARE_OFFSET = 1000000n;
const MAX_UINT = (1n << 256n) - 1n;
export function parseVaultAmount(text: string, mode: VaultMode): bigint {
    const decimals = mode === "deposit" ? 6 : SHARE_DECIMALS;
    if (!new RegExp(`^(?:\\d+\\.?\\d{0,${decimals}}|\\.\\d{1,${decimals}})$`).test(text))
        throw new Error(`Enter an amount with at most ${decimals} decimal places`);
    const value = parseUnits(text, decimals);
    if (value <= 0n || value > MAX_UINT)
        throw new Error("Enter a valid positive amount");
    return value;
}
export function depositShares(assets: bigint, core: VaultAmounts): bigint { return assets * (core.totalShares + SHARE_OFFSET) / (core.navPlus + 1n); }
export function withdrawAssets(shares: bigint, core: VaultAmounts): bigint { return shares * (core.navMinus + 1n) / (core.totalShares + SHARE_OFFSET); }
/** floor(s * numerator / denominator) <= idle, including the rounding boundary. */
export function maxWithdrawShares(core: VaultAmounts): bigint {
    const ceiling = ((core.idle + 1n) * (core.totalShares + SHARE_OFFSET) - 1n) / (core.navMinus + 1n);
    const shares = ceiling < core.userShares ? ceiling : core.userShares;
    return withdrawAssets(shares, core) > 0n ? shares : 0n;
}
export function validateVaultAmount(mode: VaultMode, amount: bigint, core: VaultAmounts) {
    if (amount <= 0n || amount > MAX_UINT)
        throw new Error("Enter a valid positive amount");
    const factor = mode === "deposit" ? core.totalShares + SHARE_OFFSET : core.navMinus + 1n;
    if (amount > MAX_UINT / factor)
        throw new Error("Amount exceeds contract limits");
    if (mode === "deposit") {
        if (amount > core.usdc)
            throw new Error("Not enough USDC");
        if (!depositShares(amount, core))
            throw new Error("Amount is too small to receive shares");
    }
    else {
        if (amount > core.userShares)
            throw new Error("Not enough shares");
        const assets = withdrawAssets(amount, core);
        if (!assets)
            throw new Error("Amount is too small to receive USDC");
        if (assets > core.idle)
            throw new Error("Not enough idle USDC. Reduce the withdrawal amount.");
    }
}
