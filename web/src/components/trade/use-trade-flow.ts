"use client";

import { useRef, useState } from "react";

export type StepId = "approve" | "sign" | "swap";
export type StepState = "idle" | "active" | "done" | "error";
export type Steps = Record<StepId, StepState>;

export const STEP_ORDER: StepId[] = ["approve", "sign", "swap"];

const APPROVE_MS = 1000;
const SIGN_MS = 700;
const HIDE_AFTER_MS = 2600;

// Mock Permit2 allowances, one approval per token for the session like a real ERC20 approve
const approved = new Set<string>();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Approve (first time per token), sign the Permit2 message, then swap, and a failed swap marks its step and rethrows */
export function useTradeFlow() {
    const [steps, setSteps] = useState<Steps | null>(null);
    const runId = useRef(0);

    const running = steps !== null && STEP_ORDER.some((s) => steps[s] === "active");

    async function run<T>(token: string, swap: () => Promise<T>): Promise<T> {
        const id = ++runId.current;
        const hideLater = () =>
            setTimeout(() => {
                if (runId.current === id) setSteps(null);
            }, HIDE_AFTER_MS);

        setSteps({ approve: "active", sign: "idle", swap: "idle" });
        if (!approved.has(token)) {
            await wait(APPROVE_MS);
            approved.add(token);
        }
        setSteps({ approve: "done", sign: "active", swap: "idle" });
        await wait(SIGN_MS);
        setSteps({ approve: "done", sign: "done", swap: "active" });
        try {
            const result = await swap();
            setSteps({ approve: "done", sign: "done", swap: "done" });
            return result;
        } catch (e) {
            setSteps({ approve: "done", sign: "done", swap: "error" });
            throw e;
        } finally {
            hideLater();
        }
    }

    return { steps, running, run };
}
