"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { STEP_ORDER, type StepId, type Steps, type StepState } from "./use-trade-flow";

const LABEL: Record<StepId, string> = { approve: "Approve", sign: "Sign", swap: "Swap" };
const SPOKEN: Record<StepState, string> = { idle: "waiting", active: "in progress", done: "done", error: "failed" };

function Dot({ state, index }: { state: StepState; index: number }) {
    return (
        <span
            aria-hidden
            className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full border font-secondary text-[11px] font-bold transition-colors",
                state === "idle" && "text-muted-foreground",
                state === "active" && "border-primary text-primary",
                state === "done" && "border-primary bg-primary text-primary-foreground",
                state === "error" && "border-down bg-down-soft text-down",
            )}
        >
            {state === "idle" && index + 1}
            {state === "active" && <Loader2 className="size-3.5 animate-spin" />}
            {state === "done" && <Check className="size-3.5" strokeWidth={3} />}
            {state === "error" && <X className="size-3.5" strokeWidth={3} />}
        </span>
    );
}

/** Approve, Sign, Swap progress under the Trade button, hidden until a trade starts */
export function TradeSteps({ steps }: { steps: Steps | null }) {
    return (
        <AnimatePresence initial={false}>
            {steps && (
                <motion.div
                    key="steps"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="overflow-hidden"
                >
                    <ol aria-label="Transaction progress" aria-live="polite" className="flex items-center gap-2 px-1 pt-4">
                        {STEP_ORDER.map((id, i) => {
                            const state = steps[id];
                            const last = i === STEP_ORDER.length - 1;
                            return (
                                <li key={id} className={cn("flex items-center gap-2", !last && "flex-1")}>
                                    <Dot state={state} index={i} />
                                    <span
                                        className={cn(
                                            "font-secondary text-xs font-semibold",
                                            state === "idle" ? "text-muted-foreground" : state === "error" ? "text-down" : "text-foreground",
                                        )}
                                    >
                                        {LABEL[id]}
                                        <span className="sr-only">, {SPOKEN[state]}</span>
                                    </span>
                                    {!last && (
                                        <span
                                            aria-hidden
                                            className={cn("h-px min-w-3 flex-1 transition-colors", state === "done" ? "bg-primary" : "bg-border")}
                                        />
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
