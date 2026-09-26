import { ExternalLink } from "lucide-react";

import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

// Local until the chain config carries an explorer
const EXPLORER_URL = "https://sepolia.uniscan.xyz";

export function TxLink({ hash, className }: { hash: string; className?: string }) {
    return (
        <a
            href={`${EXPLORER_URL}/tx/${hash}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`View transaction ${shortAddress(hash, 4, 4)} on the explorer`}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full font-mono text-xs text-muted-foreground transition-colors outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
        >
            {shortAddress(hash, 4, 4)}
            <ExternalLink aria-hidden className="size-3" />
        </a>
    );
}
