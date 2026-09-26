import { cn } from "@/lib/utils";

type PanelProps = React.ComponentProps<"div"> & {
    /** soft orchid wash for highlights and empty states */
    highlight?: boolean;
    /** drop the default padding (tables, charts that bleed to the edge) */
    flush?: boolean;
};

/** The rounded-3xl bordered surface every section sits on (atomic.cash panel). */
export function Panel({ highlight, flush, className, ...props }: PanelProps) {
    return (
        <div
            className={cn(
                "relative min-w-0 rounded-3xl border",
                highlight ? "bg-accent-wash" : "bg-surface",
                !flush && "p-5 sm:p-6",
                className,
            )}
            {...props}
        />
    );
}

/** Centered one-liner (+ optional action) on a highlighted panel. */
export function EmptyState({ title, action, className }: { title: string; action?: React.ReactNode; className?: string }) {
    return (
        <Panel highlight className={cn("flex flex-col items-center justify-center gap-5 px-8 py-12 text-center", className)}>
            <p className="text-lg font-medium">{title}</p>
            {action}
        </Panel>
    );
}
