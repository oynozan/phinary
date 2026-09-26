import { cn } from "@/lib/utils";

type DivProps = React.ComponentProps<"div">;

/** Full content width (1200px), centered, with the same side gutters as the header. */
export function PageWide({ className, ...props }: DivProps) {
    return <div className={cn("mx-auto w-full max-w-[1200px] min-w-0 px-4 sm:px-6 lg:px-10", className)} {...props} />;
}

/** Narrow centered column: "sm" = 575px (trade box, forms), "md" = 720px (lists, detail). */
export function PageNarrow({ size = "sm", className, ...props }: DivProps & { size?: "sm" | "md" }) {
    return (
        <div
            className={cn("mx-auto w-full min-w-0 px-4", size === "sm" ? "max-w-[calc(575px+2rem)]" : "max-w-[calc(720px+2rem)]", className)}
            {...props}
        />
    );
}

/** Centered page title (h1). Pages like Portfolio, Activity, Vault. */
export function PageHeading({ className, ...props }: React.ComponentProps<"h1">) {
    return <h1 className={cn("mb-8 text-center text-3xl sm:text-4xl lg:text-5xl", className)} {...props} />;
}

/** Big centered hero heading. Wrap exactly one word in <Accent>. */
export function HeroHeading({ className, ...props }: React.ComponentProps<"h1">) {
    return <h1 className={cn("mb-10 text-center text-5xl leading-[1.05] sm:text-6xl lg:mb-12 lg:text-7xl", className)} {...props} />;
}

export function Accent({ className, ...props }: React.ComponentProps<"span">) {
    return <span className={cn("text-primary", className)} {...props} />;
}

/** Section title inside a page (h2), left-aligned within its panel column. */
export function SectionHeading({ className, ...props }: React.ComponentProps<"h2">) {
    return <h2 className={cn("mb-4 text-xl sm:text-2xl", className)} {...props} />;
}
