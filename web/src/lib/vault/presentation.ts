import { formatUnits } from 'viem';
import { depositShares, withdrawAssets } from './math';
import { emptyVault, vaultColors, type VaultPresentation, type VaultCore } from './display';
import type { ExposureSnapshot } from './read';
const usdc = (n: bigint) => Number(formatUnits(n, 6));
export function presentVault(core: VaultCore | null, exposure: ExposureSnapshot | null, connected: boolean): VaultPresentation {
    const v = { ...emptyVault, loading: !core || !exposure };
    if (core) {
        v.withdrawPrice = usdc(withdrawAssets(10n ** 12n, core));
        const received = depositShares(10n ** 6n, core);
        v.depositPrice = received ? 1 / Number(formatUnits(received, 12)) : null;
        v.navMinus = usdc(core.navMinus);
        v.navPlus = usdc(core.navPlus);
        v.userValue = connected ? usdc(withdrawAssets(core.userShares, core)) : null;
        v.userPercent = connected && core.totalShares ? Number(core.userShares) / Number(core.totalShares) : null;
    }
    if (exposure) {
        v.tvl = usdc(exposure.totalValue);
        v.idle = usdc(exposure.core.idle);
        v.updatedAt = exposure.core.timestamp;
        const groups = new Map<string, bigint>();
        for (const m of exposure.markets)
            groups.set(m.category, (groups.get(m.category) ?? 0n) + m.bucket);
        v.composition = [...groups].filter(([, n]) => n > 0n).map(([label, n], i) => ({ label: `${label} Markets`, amount: usdc(n), color: vaultColors[i] }));
        v.composition.push({ label: 'Idle USDC', amount: v.idle, color: '#605077' });
        v.exposure = exposure.markets.map(m => ({ id: m.id, market: `${m.name} · #${m.id}`, category: m.category, liquidity: usdc(m.bucket), allocation: exposure.totalValue ? Number(m.bucket) / Number(exposure.totalValue) : null, utilization: m.bucket ? Number(m.liability) / Number(m.bucket) : null, volume: null, apr: null }));
    }
    return v;
}
