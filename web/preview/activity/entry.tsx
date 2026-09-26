import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityScreen } from '../../src/components/activity/activity-screen';
import type { ActivityDisplay } from '../../src/lib/activity/display';
import { referenceActivity, sampleEvent, sampleRecord } from './fixtures';
import './preview.css';
const scenarios = ['Normal', 'Empty', 'Unavailable', 'Initial loading', 'Initial failure', 'Update failure', 'Recovery', 'Missing accounting', 'No settlements'];
function initial(scenario: string): ActivityDisplay { const now = Math.floor(Date.now() / 1000); if (scenario === 'Unavailable')
    return { status: 'unavailable', snapshot: null }; if (scenario === 'Initial loading')
    return { status: 'loading', snapshot: null }; if (scenario === 'Initial failure')
    return { status: 'error', snapshot: null }; const snapshot = referenceActivity(now); if (scenario === 'Empty') {
    snapshot.events = [];
    snapshot.realized = [];
    snapshot.previousHour = { volume: 0, trades: 0 };
} if (scenario === 'No settlements')
    snapshot.realized = []; if (scenario === 'Missing accounting')
    snapshot.accountingComplete = false; return { nextUpdateAt: Date.now() + 5000, status: scenario === 'Update failure' || scenario === 'Recovery' ? 'paused' : 'ready', snapshot }; }
function Simulation({ scenario, paused }: {
    scenario: string;
    paused: boolean;
}) { const [display, setDisplay] = useState(() => initial(scenario)); const index = useRef(10000); useEffect(() => { if (paused || ['Unavailable', 'Initial loading', 'Initial failure', 'Update failure'].includes(scenario))
    return; const timer = setInterval(() => { const now = Math.floor(Date.now() / 1000); index.current++; setDisplay(old => { if (!old.snapshot)
    return old; return { status: 'ready', nextUpdateAt: Date.now() + 5000, snapshot: { ...old.snapshot, asOf: now, events: scenario === 'Empty' ? [] : [sampleEvent(now, index.current), ...old.snapshot.events].filter(r => r.timestamp > now - 3600), realized: scenario === 'No settlements' || scenario === 'Empty' ? [] : [sampleRecord(now, index.current), ...old.snapshot.realized].filter(r => r.timestamp > now - 3600) } }; }); }, 5000); return () => clearInterval(timer); }, [scenario, paused]); return <ActivityScreen display={paused && display.snapshot ? { ...display, status: 'paused' } : display}/>; }
function Preview() { const [scenario, setScenario] = useState('Normal'), [paused, setPaused] = useState(false), [revision, setRevision] = useState(0); return <><header className="preview-header"><a className="preview-brand" href="http://localhost:3101"><svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true"><defs><linearGradient id="preview-phi" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="30" y2="34"><stop stopColor="#63dcff"/><stop offset="1" stopColor="#bc35f0"/></linearGradient></defs><ellipse cx="15" cy="17" rx="12" ry="9" fill="none" stroke="url(#preview-phi)" strokeWidth="5"/><path d="M15 1v32" stroke="url(#preview-phi)" strokeWidth="5"/></svg>Phinary</a><nav>{['Markets', 'Portfolio', 'Activity', 'Vault'].map(name => <a key={name} aria-current={name === 'Activity' ? 'page' : undefined} href={name === 'Activity' ? '/' : `http://localhost:3101/${name === 'Markets' ? '' : name.toLowerCase()}`}>{name}</a>)}</nav><span className="preview-wallet" title="Sample preview; no wallet connection">Connect wallet</span></header><main><Simulation key={`${scenario}:${revision}`} scenario={scenario} paused={paused}/></main><aside className="preview-toolbar" aria-label="Preview controls"><strong>UI preview · Sample data</strong><label>Scenario <select value={scenario} onChange={e => setScenario(e.target.value)}>{scenarios.map(s => <option key={s}>{s}</option>)}</select></label><button onClick={() => setPaused(p => !p)}>{paused ? 'Resume updates' : 'Pause updates'}</button><button onClick={() => setRevision(r => r + 1)}>Reset</button><span>Local simulation · No wallet or RPC</span></aside></>; }
createRoot(document.getElementById('root')!).render(<Preview />);
