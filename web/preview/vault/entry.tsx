import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { formatUnits } from 'viem';
import { VaultScreen } from '../../src/components/vault/vault-screen';
import { emptyVault, type VaultMode } from '../../src/lib/vault/display';
import { depositShares, withdrawAssets, validateVaultAmount } from '../../src/lib/vault/math';
import { sampleCore, sampleView } from './fixtures';
import './preview.css';
const scenarios = ['Normal', 'Disconnected', 'Wrong network', 'Loading', 'Update failure', 'Limited idle', 'Rejected', 'Revert', 'Confirmation delay'];
function Preview() {
    const [core, setCore] = useState(sampleCore), [scenario, setScenario] = useState('Normal'), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [paused, setPaused] = useState(false);
    useEffect(() => { if (paused || scenario === 'Update failure')
        return; const id = setInterval(() => setCore(c => ({ ...c, timestamp: Math.floor(Date.now() / 1000), fetchedAt: Date.now() })), 5000); return () => clearInterval(id); }, [paused, scenario]);
    const current = scenario === 'Limited idle' ? { ...core, idle: 1000000n } : core;
    const view = scenario === 'Loading' ? emptyVault : sampleView(current);
    if (paused || scenario === 'Update failure') {
        view.live = false;
        view.error = 'Sample update failed. Last successful values are retained.';
    }
    async function submit(mode: VaultMode, amount: bigint) { validateVaultAmount(mode, amount, current); setBusy(true); setMessage('Simulating confirmation…'); try {
        await new Promise(r => setTimeout(r, scenario === 'Confirmation delay' ? 5000 : 700));
        if (scenario === 'Rejected')
            throw Error('Simulation: cancelled in wallet');
        if (scenario === 'Revert')
            throw Error('Simulation: transaction reverted');
        const shares = mode === 'deposit' ? depositShares(amount, current) : amount, assets = mode === 'deposit' ? amount : withdrawAssets(amount, current);
        const sign = mode === 'deposit' ? 1n : -1n;
        setCore(c => ({ ...c, idle: c.idle + sign * assets, navPlus: c.navPlus + sign * assets, navMinus: c.navMinus + sign * assets, totalShares: c.totalShares + sign * shares, userShares: c.userShares + sign * shares, usdc: c.usdc - sign * assets, fetchedAt: Date.now() }));
        setMessage(`Simulation complete · ${formatUnits(assets, 6)} USDC · No real transaction`);
    }
    catch (e) {
        setMessage(e instanceof Error ? e.message : 'Simulation failed');
        throw e;
    }
    finally {
        setBusy(false);
    } }
    return <><header className="preview-header"><a className="preview-brand" href="http://localhost:3101"><svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true"><defs><linearGradient id="phi" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="30" y2="34"><stop stopColor="#63dcff"/><stop offset="1" stopColor="#bc35f0"/></linearGradient></defs><ellipse cx="15" cy="17" rx="12" ry="9" fill="none" stroke="url(#phi)" strokeWidth="5"/><path d="M15 1v32" stroke="url(#phi)" strokeWidth="5"/></svg>Phinary</a><nav>{['Markets', 'Portfolio', 'Activity', 'Vault'].map(name => <a key={name} aria-current={name === 'Vault' ? 'page' : undefined} href={name === 'Vault' ? '/' : `http://localhost:3101/${name === 'Markets' ? '' : name.toLowerCase()}`}>{name}</a>)}</nav><span className="preview-wallet">${Number(formatUnits(core.usdc, 6)).toFixed(2)} USDC</span><span className="preview-wallet">● 0x7a3f…c91e</span></header><span className="preview-sample-badge">Sample data</span><main><VaultScreen view={view} core={scenario === 'Loading' ? null : current} connected={scenario !== 'Disconnected'} wrongNetwork={scenario === 'Wrong network'} busy={busy} message={message} onConnect={() => setScenario('Normal')} onSwitch={() => setScenario('Normal')} onSubmit={submit} onRetry={() => { setScenario('Normal'); setPaused(false); }} demo/></main><aside className="preview-toolbar" aria-label="Preview controls"><strong>Sample data · No real transactions</strong><label>Scenario <select value={scenario} disabled={busy} onChange={e => { setScenario(e.target.value); setMessage(''); }}>{scenarios.map(s => <option key={s}>{s}</option>)}</select></label><button onClick={() => setPaused(p => !p)}>{paused ? 'Resume updates' : 'Pause updates'}</button><button disabled={busy} onClick={() => { setCore(sampleCore()); setScenario('Normal'); setMessage(''); }}>Reset</button></aside></>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
