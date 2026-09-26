import { compactUsd, pct, type VaultPresentation } from '@/lib/vault/display';
export function MiniLine({ values, label }: {
    values: number[] | null;
    label: string;
}) {
    if (!values || values.length < 2)
        return null;
    const min = Math.min(...values), span = Math.max(...values) - min || 1;
    const points = values.map((n, i) => `${i / (values.length - 1) * 240},${36 - (n - min) / span * 30}`).join(' ');
    return <svg className="vault-mini-line" viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label={label}><polyline points={points} fill="none" stroke="#d84bf1" strokeWidth="1.2" vectorEffect="non-scaling-stroke"/></svg>;
}
export function ThinBar({ value, label }: {
    value: number | null;
    label: string;
}) {
    return <span className="vault-bar" role="img" aria-label={`${label}: ${pct(value)}`}><i style={{ width: `${Math.min(100, Math.max(0, (value ?? 0) * 100))}%` }}/></span>;
}
export function Composition({ view }: {
    view: VaultPresentation;
}) {
    const total = view.composition.reduce((sum, item) => sum + item.amount, 0);
    let offset = 0;
    return <section className="vault-panel vault-composition" aria-labelledby="vault-composition-title"><header><h2 id="vault-composition-title">Vault Composition</h2>{view.updatedAt && <span className={view.live ? 'vault-live' : 'vault-delayed'}>{view.live ? 'Live' : 'Updates delayed'}</span>}</header><div className="vault-composition-chart"><div className="vault-donut"><svg viewBox="0 0 200 200" role="img" aria-label="Vault collateral composition"><circle cx="100" cy="100" r="80" fill="none" stroke="#2c2339" strokeWidth="30"/>{total > 0 && view.composition.map(item => { const share = item.amount / total; const start = offset; offset += share; return <circle key={item.label} cx="100" cy="100" r="80" fill="none" stroke={item.color} strokeWidth="30" pathLength="1" strokeDasharray={`${share} ${1 - share}`} strokeDashoffset={-start} transform="rotate(-90 100 100)"/>; })}</svg><div><strong>{compactUsd(view.tvl)}</strong><span>Total Value</span></div></div><ul className="vault-legend">{view.composition.map(item => <li key={item.label}><i style={{ background: item.color }}/><span>{item.label}</span><strong>{total > 0 ? `${Math.round(item.amount / total * 100)}%` : 'N/A'}</strong></li>)}{!view.composition.length && <li>Composition unavailable</li>}</ul></div><div className="vault-composition-bottom"><div><span>Idle USDC</span><strong>{compactUsd(view.idle)}</strong><small>{view.tvl && view.idle !== null ? pct(view.idle / view.tvl) : 'N/A'} of vault</small></div><div><span>Active in Markets</span><strong>{compactUsd(view.tvl !== null && view.idle !== null ? view.tvl - view.idle : null)}</strong><small>{view.tvl && view.idle !== null ? pct(1 - view.idle / view.tvl) : 'N/A'} of vault</small></div></div></section>;
}
