"use client";
import { useEffect, useState } from "react";

export function LiveStatus({ ready, asOf, nextUpdateAt }: { ready: boolean; asOf: number; nextUpdateAt?: number }) {
    const [now, setNow] = useState(0);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const seconds = nextUpdateAt ? Math.max(0, Math.min(5, Math.ceil((nextUpdateAt - (now || nextUpdateAt - 5000)) / 1000))) : null;
    return <div className="activity-status" role="status"><span className={ready ? "activity-live" : "activity-delayed"}>{ready ? "Live" : "Updates delayed"}</span><small title={new Date(asOf * 1000).toISOString()}>{ready && seconds !== null ? seconds ? `Updating in ${seconds}s…` : "Updating…" : `As of ${new Date(asOf * 1000).toISOString().slice(11, 19)} UTC`}</small></div>;
}

export function SparkBars({ values, label }: { values: number[] | null; label: string }) {
    if (!values) return null;
    const max = Math.max(...values, 1);
    return <svg className="activity-spark" viewBox="0 0 108 48" role="img" aria-label={`${label}, eighteen intervals in the last hour`}><defs><linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#dc3cff"/><stop offset="1" stopColor="#7715b6" stopOpacity=".12"/></linearGradient></defs>{values.map((n, i) => <rect key={i} x={i * 6 + 1} y={46 - n / max * 43} width="2.5" height={n / max * 43} rx="1" fill={`url(#spark-${label})`}/>)}</svg>;
}

export function WinRing({ rate }: { rate: number | null }) {
    const circumference = 2 * Math.PI * 34;
    return <div className="activity-win-ring"><svg viewBox="0 0 84 84" aria-hidden="true"><defs><linearGradient id="activity-ring" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#7433c8"/><stop offset="1" stopColor="#d22df7"/></linearGradient></defs><circle cx="42" cy="42" r="34" fill="none" stroke={rate === null ? '#292138' : 'url(#activity-ring)'} strokeWidth="10"/>{rate !== null && <circle cx="42" cy="42" r="34" fill="none" stroke="#17dca0" strokeWidth="10" strokeDasharray={`${rate * circumference} ${circumference}`} transform="rotate(-90 42 42)"/>}</svg><strong>{rate === null ? 'N/A' : `${Math.round(rate * 100)}%`}</strong></div>;
}

/** Faceted Ethereum mark, drawn as simple logo geometry. */
export function EthereumMark() {
    return <svg className="activity-ethereum" viewBox="0 0 190 120" aria-hidden="true"><defs><linearGradient id="eth-light" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#bceaff"/><stop offset=".5" stopColor="#7775ff"/><stop offset="1" stopColor="#5216ca"/></linearGradient><linearGradient id="eth-dark"><stop stopColor="#271077"/><stop offset="1" stopColor="#8357fa"/></linearGradient></defs><ellipse cx="95" cy="67" rx="82" ry="24" transform="rotate(-18 95 67)" fill="none" stroke="#b632eb" strokeWidth="1.2"/><path d="M99 9 70 63 99 80 128 63Z" fill="url(#eth-light)"/><path d="m99 9 0 71 29-17Z" fill="url(#eth-dark)"/><path d="m70 63 29-14 29 14-29 17Z" fill="#5352ef" fillOpacity=".7"/><path d="m70 70 29 41 29-41-29 18Z" fill="url(#eth-light)"/><path d="m99 88 29-18-29 41Z" fill="#4721ba"/><path d="M99 9v40L70 63" fill="none" stroke="#aab9ff" strokeOpacity=".6"/></svg>;
}
