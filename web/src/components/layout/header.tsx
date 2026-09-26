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

/** Shared navigation; wallet behavior stays in its existing components. */
export function Header() {
    const pathname = usePathname();

    return (
        <header className="app-header">
            <div className="app-header-inner">
                <Logo />

                <nav className="app-header-nav hidden lg:flex">
                    {NAV_ITEMS.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            aria-current={isActivePath(pathname, item.href) ? "page" : undefined}
                            className={cn(
                                "app-header-link",
                                isActivePath(pathname, item.href) ? "is-active" : "",
                            )}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>

                <div className="flex min-w-0 items-center justify-end gap-2">
                    <BalancePill className="header-balance hidden md:flex" />
                    <ConnectButton className="header-wallet" />
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
