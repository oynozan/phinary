"use client";
import { useEffect, useRef, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { WalletDialog } from '@/components/wallet/wallet-dialog';
import { captureWallet, refreshWalletBalances, switchWalletNetwork, useWalletSession } from '@/lib/onchain/wallet';
import { getConnectionConfig } from '@/lib/onchain/config';
import { createChainClient } from '@/lib/onchain/client';
import { readVaultCore, readVaultExposure, type CoreSnapshot, type ExposureSnapshot } from '@/lib/vault/read';
import { executeVault, resumeVaultTransaction, describeVaultError, type VaultPending, type VaultResult } from '@/lib/vault/transaction';
import { presentVault } from '@/lib/vault/presentation';
import type { VaultMode } from '@/lib/vault/display';
import { VaultScreen } from './vault-screen';
import { acquireOperation, rememberPending } from "@/lib/onchain/operation-lock";
const config = getConnectionConfig();
const storageKey = `phinary:vault:pending:${config.cacheKey}`;
function readPending(): VaultPending | null { try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return value && /^0x[0-9a-f]{64}$/i.test(value.hash) && /^0x[0-9a-f]{40}$/i.test(value.account) && ['approve', 'deposit', 'withdraw'].includes(value.kind) && value.chainId === config.chainId && value.contract === config.predictionHook ? value : null;
}
catch {
    return null;
} }
function resultMessage(result: VaultResult | null) { return result ? `${result.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} confirmed: ${formatUnits(result.assets, 6)} USDC · ${formatUnits(result.shares, 12)} shares.` : 'Approval confirmed. Review the refreshed estimate and submit your deposit.'; }
function LiveVault({ account }: {
    account?: Address;
}) {
    const wallet = useWalletSession();
    const [core, setCore] = useState<CoreSnapshot | null>(null), [exposure, setExposure] = useState<ExposureSnapshot | null>(null), [coreError, setCoreError] = useState(''), [exposureError, setExposureError] = useState('');
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [pending, setPending] = useState<VaultPending | null>(null), [revision, setRevision] = useState(0);
    const active = useRef(true), lock = useRef(false);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const savePending = (value: VaultPending | null) => {
        rememberPending("vault", Boolean(value));
        try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); } catch { /* preserve pending in memory */ }
        if (active.current) setPending(value);
    };
    useEffect(() => { let stopped = false; let timer: ReturnType<typeof setTimeout>; async function poll() { try {
        const next = await readVaultCore(account);
        if (!stopped) {
            setCore(next);
            setCoreError('');
        }
    }
    catch {
        if (!stopped)
            setCoreError('Vault balances delayed. Submission paused until a fresh read succeeds.');
    }
    finally {
        if (!stopped)
            timer = setTimeout(poll, 5000);
    } } void poll(); return () => { stopped = true; clearTimeout(timer); }; }, [account, revision]);
    useEffect(() => { let stopped = false; let timer: ReturnType<typeof setTimeout>; async function poll() { try {
        const next = await readVaultExposure();
        if (!stopped) {
            setExposure(next);
            setExposureError('');
        }
    }
    catch {
        if (!stopped)
            setExposureError('Market exposure delayed; showing the last successful snapshot.');
    }
    finally {
        if (!stopped)
            timer = setTimeout(poll, 30000);
    } } void poll(); return () => { stopped = true; clearTimeout(timer); }; }, [revision]);
    const refresh = () => { setRevision(r => r + 1); void refreshWalletBalances(); };
    async function recover(value: VaultPending) { if (lock.current)
        return; lock.current = true; setBusy(true); try {
        const result = await resumeVaultTransaction(value, { client: createChainClient(), onPending: savePending, onProgress: p => { if (active.current)
                setMessage(p.message); } }, true);
        if (active.current) {
            setMessage(resultMessage(result));
            refresh();
        }
    }
    catch (error) {
        if (active.current)
            setMessage(describeVaultError(error));
    }
    finally {
        lock.current = false;
        if (active.current)
            setBusy(false);
    } }
    useEffect(() => {
        const timer = setTimeout(() => { const value = readPending(); if (value) {
            rememberPending("vault", true); setPending(value);
            void recover(value);
        } }, 0);
        return () => clearTimeout(timer); // Recover receipt only, never resubmit on reload.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    async function submit(mode: VaultMode, amount: bigint) { if (lock.current || pending)
        throw Error('A transaction is already pending'); const release = acquireOperation(); lock.current = true; setBusy(true); setMessage('Checking wallet and current vault state…'); try {
        const session = captureWallet();
        const result = await executeVault(mode, amount, { ...session, onPending: savePending, onProgress: p => { if (active.current)
                setMessage(p.message); } });
        if (active.current) {
            setMessage(resultMessage(result));
            refresh();
        }
    }
    catch (error) {
        const text = describeVaultError(error);
        if (active.current)
            setMessage(text);
        throw Error(text);
    }
    finally {
        release();
        lock.current = false;
        if (active.current)
            setBusy(false);
    } }
    const view = presentVault(core, exposure, !!account);
    view.error = [coreError, exposureError].filter(Boolean).join(' ') || undefined;
    view.live = !!exposure && !view.error;
    view.loading = (!core && !coreError) || (!exposure && !exposureError);
    return <><VaultScreen view={view} core={coreError ? null : core} connected={!!account} connecting={wallet.status === 'connecting'} wrongNetwork={!!account && wallet.chainId !== config.chainId} busy={busy} pending={!!pending} message={message} onConnect={() => setOpen(true)} onSwitch={() => { void switchWalletNetwork().catch(e => setMessage(describeVaultError(e))); }} onSubmit={submit} onRetry={refresh} onCheckPending={() => { if (pending)
        void recover(pending); }}/><WalletDialog open={open} onOpenChange={setOpen}/></>;
}
export function VaultView() { const wallet = useWalletSession(); return <LiveVault key={`${wallet.address ?? 'guest'}:${wallet.chainId}`} account={wallet.status === 'connected' ? wallet.address ?? undefined : undefined}/>; }
