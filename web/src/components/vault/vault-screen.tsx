"use client";
import Link from "next/link";
import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Info, Wallet, Zap, ChartNoAxesColumnIncreasing, DollarSign } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { EthereumMark } from '@/components/activity/activity-visuals';
import { depositShares, withdrawAssets, maxWithdrawShares, parseVaultAmount } from '@/lib/vault/math';
import { usd, pct, sortExposure, type VaultCore, type VaultMode, type VaultPresentation, type SortKey } from '@/lib/vault/display';
import { Composition, MiniLine, ThinBar } from './vault-charts';
import './vault.css';
export interface VaultScreenProps {
    view: VaultPresentation;
    core: VaultCore | null;
    connected: boolean;
    wrongNetwork: boolean;
    connecting?: boolean;
    busy: boolean;
    message?: string;
    pending?: boolean;
    onConnect: () => void;
    onSwitch: () => void;
    onSubmit: (mode: VaultMode, amount: bigint) => Promise<void>;
    onCheckPending?: () => void;
    onRetry?: () => void;
    demo?: boolean;
}
const displayShares = (n: bigint) => Number(formatUnits(n, 12)).toLocaleString('en-US', { maximumFractionDigits: 6 });
function InfoLabel({ children, description }: {
    children: React.ReactNode;
    description: string;
}) { return <span className="vault-metric-label">{children}<span tabIndex={0} className="vault-info" aria-label={description}><Info size={12} aria-hidden="true"/><span role="tooltip">{description}</span></span></span>; }
function Delta({ value }: {
    value: number | null;
}) { return value === null ? null : <span className={`vault-delta ${value < 0 ? 'is-negative' : ''}`}>{value < 0 ? '↓' : '↑'} {value > 0 ? '+' : ''}{value.toFixed(1)}%</span>; }
function Summary({ view: v }: {
    view: VaultPresentation;
}) {
    return <section className="vault-metrics" aria-label="Vault metrics" aria-busy={v.loading}>
 <div className="vault-metric"><InfoLabel description="USDC collateral held in idle funds and all market buckets, including funds reserved for trader payouts.">Total Value Locked</InfoLabel><div className="vault-metric-value"><strong>{usd(v.tvl, 0)}</strong><Delta value={v.tvlChange}/></div><MiniLine values={v.tvlHistory} label="Sample TVL history"/></div>
 <div className="vault-metric"><InfoLabel description="Estimated USDC received per displayed share on withdrawal. Deposits use a different, upper NAV price.">Share Price</InfoLabel><div className="vault-metric-value"><strong>{usd(v.withdrawPrice, 4)}</strong><Delta value={v.priceChange}/></div><small>Withdrawal value per share</small></div>
 <div className="vault-metric"><span className="vault-metric-label">Your share <small>(estimated value)</small></span><div className="vault-metric-value"><strong>{usd(v.userValue)}</strong></div><small>{pct(v.userPercent)} of vault shares</small></div>
 <div className="vault-metric"><InfoLabel description="Historical fee APY is not yet indexed. Any value shown in the sample preview is illustrative, not a forecast.">Estimated APY</InfoLabel><div className="vault-metric-value"><strong>{pct(v.apy)}</strong></div>{v.apyHistory ? <MiniLine values={v.apyHistory} label="Sample APY history"/> : <small>History unavailable</small>}</div>
 <div className="vault-metric"><span className="vault-metric-label">Idle Funds</span><div className="vault-metric-value"><strong>{usd(v.idle, 0)}</strong></div><div className="vault-inline-bar"><small>{v.tvl && v.idle !== null ? pct(v.idle / v.tvl) : 'N/A'}</small><ThinBar value={v.tvl && v.idle !== null ? v.idle / v.tvl : null} label="Idle allocation"/></div></div>
 <div className="vault-metric vault-range"><InfoLabel description="Contract NAV− to NAV+. These bound vault equity after payout liabilities; this is not an adjustable range.">Vault Range <small>(Total Value)</small></InfoLabel><strong>{usd(v.navMinus, 0)} – {usd(v.navPlus, 0)}</strong><div className="vault-static-range" role="img" aria-label={`Vault equity range ${usd(v.navMinus)} to ${usd(v.navPlus)}`}><i /></div><div><small>NAV−</small><small>NAV+</small></div></div>
 </section>;
}
function VaultForm(p: VaultScreenProps) {
    const [mode, setMode] = useState<VaultMode>('deposit'), [input, setInput] = useState(''), [localError, setLocalError] = useState('');
    const [now, setNow] = useState(0);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const core = p.core, deposit = mode === 'deposit';
    const fresh = !!core && !p.view.error && (now === 0 || now - core.fetchedAt < 15000);
    let amount: bigint | null = null, receive = 0n, validation = '';
    try {
        amount = parseVaultAmount(input, mode);
    }
    catch (error) {
        validation = input ? (error instanceof Error ? error.message : 'Enter a valid amount') : 'Enter an amount';
    }
    if (core && amount !== null) {
        if (deposit) {
            receive = depositShares(amount, core);
            if (amount > core.usdc)
                validation = 'Not enough USDC';
        }
        else {
            receive = withdrawAssets(amount, core);
            if (amount > core.userShares)
                validation = 'Not enough shares';
            else if (amount > maxWithdrawShares(core))
                validation = 'Exceeds available idle funds';
        }
        if (receive === 0n && !validation)
            validation = 'Amount is too small';
    }
    const max = core ? deposit ? core.usdc : maxWithdrawShares(core) : 0n;
    const change = (value: string) => { setInput(value); setLocalError(''); };
    const disabled = p.busy || !!p.pending;
    const blocked = !fresh ? 'Vault data unavailable' : validation;
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!p.connected) {
            p.onConnect();
            return;
        }
        if (p.wrongNetwork) {
            p.onSwitch();
            return;
        }
        if (!amount || blocked || disabled)
            return;
        setLocalError('');
        try {
            await p.onSubmit(mode, amount);
            setInput('');
        }
        catch (error) {
            setLocalError(error instanceof Error ? error.message : 'Transaction could not complete');
        }
    }
    return <form className="vault-panel vault-form" onSubmit={submit} aria-label="Vault deposit and withdrawal">
 <div className="vault-tabs" role="group" aria-label="Vault action">{(['deposit', 'withdraw'] as const).map(m => <button type="button" key={m} aria-pressed={mode === m} disabled={disabled} onClick={() => { setMode(m); change(''); }}>{m === 'deposit' ? 'Deposit' : 'Withdraw'}</button>)}</div>
 <div className="vault-form-intro"><span>{deposit ? 'Deposit USDC to receive vault shares.' : 'Redeem shares for available idle USDC.'}</span><span><Wallet size={13} aria-hidden="true"/>{!p.connected ? 'Not connected' : core ? deposit ? Number(formatUnits(core.usdc, 6)).toLocaleString('en-US', { maximumFractionDigits: 6 }) : `${displayShares(core.userShares)} shares` : 'N/A'}</span></div>
 <label htmlFor="vault-amount">{deposit ? 'Amount' : 'Shares to withdraw'}</label><div className="vault-amount-field"><input id="vault-amount" value={input} onChange={e => change(e.target.value)} placeholder="0" inputMode="decimal" autoComplete="off" spellCheck={false} disabled={disabled} aria-describedby="vault-estimate vault-form-status" aria-invalid={!!input && !!validation}/><span>{deposit && <i className="vault-usdc-mark" aria-hidden="true">$</i>}{deposit ? 'USDC' : 'shares'}</span></div>
 <div className="vault-quick">{(deposit ? [10, 50, 100] : [25, 50, 100]).map(n => <button key={n} type="button" disabled={disabled || (!deposit && !core)} onClick={() => change(deposit ? String(n) : formatUnits(max * BigInt(n) / 100n, 12))}>{deposit ? `$${n}` : `${n}%`}</button>)}<button type="button" disabled={disabled || !core || !p.connected || p.wrongNetwork} onClick={() => change(formatUnits(max, deposit ? 6 : 12))}>Max</button></div>
 <div className="vault-estimate" id="vault-estimate"><div><span>You will receive (estimated)</span><span>1 share = {usd(deposit ? p.view.depositPrice : p.view.withdrawPrice, 4)}</span></div><strong>{amount && core && fresh ? deposit ? displayShares(receive) : Number(formatUnits(receive, 6)).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '0'} <small>{deposit ? 'shares' : 'USDC'}</small></strong></div>
 <button type="submit" className="vault-primary" disabled={disabled || (p.connected && !p.wrongNetwork && !!blocked)}>{p.busy ? 'Processing…' : p.pending ? 'Confirmation pending' : !p.connected ? p.connecting ? 'Connecting…' : 'Connect wallet' : p.wrongNetwork ? 'Switch network' : deposit ? 'Deposit USDC' : 'Withdraw USDC'}</button>
 <div className="vault-form-status" id="vault-form-status" role="status">{localError || p.message || (p.connected && !p.wrongNetwork && input && validation) || (!fresh && p.connected ? 'Waiting for fresh vault data.' : 'Estimates can change before confirmation. Withdrawals are limited by idle funds.')}</div>
 {p.pending && p.onCheckPending && <button type="button" className="vault-text-button" disabled={p.busy} onClick={p.onCheckPending}>Check confirmation</button>}
 </form>;
}
function HowItWorks() {
    const steps = [{ title: 'You provide liquidity', body: 'Deposit USDC into the vault. Your funds are used to underwrite binary markets on Phinary.', Icon: Zap }, { title: 'Traders pay premiums', body: 'Trading premiums, spreads and settlement payouts affect the value of the vault.', Icon: ChartNoAxesColumnIncreasing }, { title: 'Your shares track the vault', body: 'Your share value can rise or fall. Withdrawals use the lower NAV and available idle funds.', Icon: DollarSign }];
    return <section className="vault-panel vault-how"><header><h2>How the Vault Works</h2><Dialog><DialogTrigger className="vault-learn">Learn more <ChevronRight size={13}/></DialogTrigger><DialogContent className="vault-explanation"><DialogTitle>How your vault shares work</DialogTitle><DialogDescription>Deposits are priced at NAV+, while withdrawals are priced at NAV−. They are different contract valuations, not a guaranteed fixed share price.</DialogDescription><p>Funds back market payouts. Trading activity and outcomes can increase or reduce vault equity. No fixed yield is guaranteed.</p><p>You can only redeem shares when enough idle USDC is available. The displayed estimate is refreshed before submission, but the contract has no minimum-output parameter: the confirmed amount may change.</p><p>One displayed share represents 10¹² integer share units. The Vault Range shows the contract’s lower and upper equity bounds after payout liabilities.</p></DialogContent></Dialog></header><ol>{steps.map(({ title, body, Icon }, i) => <li key={title}><span className="vault-step-icon"><Icon aria-hidden="true"/></span><div><h3>{i + 1}. {title}</h3><p>{body}</p></div></li>)}</ol></section>;
}
function Exposure({ view }: {
    view: VaultPresentation;
}) {
    const [category, setCategory] = useState('All Markets'), [sort, setSort] = useState<SortKey>('liquidity'), [descending, setDescending] = useState(true), [all, setAll] = useState(false);
    const categories = ['All Markets', ...new Set(view.exposure.map(r => r.category))];
    const filtered = sortExposure(view.exposure, categories.includes(category) ? category : 'All Markets', sort, descending), rows = all ? filtered : filtered.slice(0, 5);
    const columns: [
        SortKey,
        string
    ][] = [['liquidity', 'Total Liquidity'], ['allocation', 'Vault Allocation'], ['utilization', 'Current Utilization'], ['volume', '24h Volume'], ['apr', 'Fee APR']];
    return <section className="vault-panel vault-exposure" aria-labelledby="vault-exposure-title"><header><div><h2 id="vault-exposure-title">Exposure by Market</h2><p>How your liquidity is allocated across markets.</p></div><div className="vault-filters" role="group" aria-label="Market category">{categories.map(c => <button key={c} aria-pressed={c === category} onClick={() => { setCategory(c); setAll(false); }}>{c}</button>)}</div></header><div className="vault-table-scroll" tabIndex={0} role="region" aria-label="Market exposure table"><table><thead><tr><th scope="col">Market</th><th scope="col">Category</th>{columns.map(([key, label]) => <th scope="col" key={key} aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}>{view.exposure.some(r => r[key] !== null) ? <button onClick={() => { setSort(key); setDescending(sort === key ? !descending : true); }}>{label}{sort === key ? descending ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown />}</button> : label}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.id}><th scope="row"><span className="vault-market-mark" aria-hidden="true">{r.category === 'Crypto' ? <svg viewBox="0 0 20 30" fill="none"><path d="M10 1 1 16 10 21 19 16Z" fill="#eef0ff"/><path d="M10 1v20l9-5Z" fill="#9caaff"/><path d="m1 18 9 11 9-11-9 6Z" fill="#dadfff"/></svg> : r.category.slice(0, 1)}</span>{r.market}</th><td>{r.category}</td><td>{usd(r.liquidity, 0)}</td><td><span className="vault-cell-bar">{pct(r.allocation)}<ThinBar value={r.allocation} label="Vault allocation"/></span></td><td><span className="vault-cell-bar">{pct(r.utilization)}<ThinBar value={r.utilization} label="Maximum payout liability divided by market collateral"/></span></td><td>{usd(r.volume, 0)}</td><td>{pct(r.apr)}</td></tr>)}</tbody></table></div>{!rows.length && <p className="vault-table-empty">{view.loading ? 'Loading market exposure…' : view.error ? 'Market exposure temporarily unavailable.' : 'No funded markets.'}</p>}<footer><span>Showing {rows.length} of {filtered.length} markets</span>{filtered.length > 5 && <button onClick={() => setAll(!all)}>{all ? 'Show fewer markets' : 'View all markets'} <ChevronRight size={13}/></button>}</footer></section>;
}
export function VaultScreen(props: VaultScreenProps) {
    return <div className="vault-page"><div className="vault-container"><header className="vault-hero"><div><h1>Vault</h1><p>Provide liquidity to power binary markets and earn fees.</p><span>Your capital enables trading. Earn a share of protocol fees, automatically.</span></div><div className="vault-hero-art"><EthereumMark /><span>SAME MARKETS.<br />A MORE OPEN WORLD.<i /></span></div></header>{!props.connected ? <section className="vault-connect" aria-labelledby="vault-connect-title">
        <h2 id="vault-connect-title">View and manage your vault shares</h2>
        <p>Connect your wallet to view your balance, deposit USDC and manage withdrawals.</p>
        <button type="button" className="vault-primary" disabled={props.connecting} onClick={props.onConnect}>{props.connecting ? 'Connecting…' : 'Connect wallet'}</button>
        <Link href="/">Explore markets</Link>
        {props.message && <p role="status">{props.message}</p>}
        {props.pending && props.onCheckPending && <button type="button" className="vault-text-button" disabled={props.busy} onClick={props.onCheckPending}>Check confirmation</button>}
    </section> : <><Summary view={props.view}/>{props.view.error && <div className="vault-error" role="status">{props.view.error}{props.onRetry && <button onClick={props.onRetry}>Retry</button>}</div>}<div className="vault-main"><VaultForm {...props}/><HowItWorks /><Composition view={props.view}/></div><Exposure view={props.view}/><footer className="vault-page-footer"><span>Phinary <i /> Liquidity for the next outcome.</span><span>{props.demo ? 'Sample data · No real transactions' : props.view.updatedAt ? `As of ${new Date(props.view.updatedAt * 1000).toISOString().slice(11, 19)} UTC` : 'Read-only data loading'}</span></footer></>}</div></div>;
}
