import { getConnectionConfig } from './config.ts';

let active = false;
const pending = new Set<string>();
export function rememberPending(kind: string, value: boolean) { if (value) pending.add(kind); else pending.delete(kind); }
/** Shared across routes. Pending records survive navigation and reload. */
export function acquireOperation(recovery = false): () => void {
    if (active) throw new Error('Another wallet operation is in progress');
    if (!recovery && pending.size) throw new Error('Check confirmation on the market, Portfolio or Vault page before starting another operation');
    if (!recovery && typeof localStorage !== 'undefined') {
        const config = getConnectionConfig();
        for (const key of [`phinary.pending:${config.cacheKey}`, `phinary:vault:pending:${config.cacheKey}`]) {
            let value: string | null = null;
            try { value = localStorage.getItem(key); } catch { /* in-memory lock remains active */ }
            if (value) throw new Error('Check the existing pending transaction before starting another operation');
        }
    }
    active = true;
    return () => { active = false; };
}
