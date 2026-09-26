"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BalancePill } from "@/components/wallet/balance-pill";
import { ConnectButton } from "@/components/wallet/connect-button";
import { cn } from "@/lib/utils";

import { Logo } from "./logo";
import { isActivePath, NAV_ITEMS } from "./nav-items";

/** Floating pill header (atomic.cash): logo left, text nav centered, wallet right. */
export function Header() {
    const pathname = usePathname();

    return (
        <header className="fixed z-50 flex w-full items-center justify-center px-2 pt-4 sm:px-4">
            <div className="flex h-(--header-h) w-full max-w-[1200px] min-w-0 items-center justify-between gap-2 rounded-full border bg-surface px-4 sm:gap-4 sm:px-6 lg:px-10">
                <Logo />

                <nav className="hidden min-w-0 flex-1 justify-center gap-6 lg:flex">
                    {NAV_ITEMS.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "text-lg transition-colors",
                                isActivePath(pathname, item.href) ? "text-white" : "text-muted-foreground hover:text-primary",
                            )}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>

                <div className="flex min-w-0 items-center justify-end gap-2">
                    <BalancePill className="hidden md:flex" />
                    <ConnectButton />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="secondary"
                                size="icon"
                                className="size-9 sm:size-11 lg:hidden"
                                aria-label="Open menu"
                            >
                                <Menu className="size-6" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                            {NAV_ITEMS.map((item) => (
                                <DropdownMenuItem key={item.href} asChild>
                                    <Link href={item.href} className={cn(isActivePath(pathname, item.href) && "text-primary")}>
                                        {item.label}
                                    </Link>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </header>
    );
}
