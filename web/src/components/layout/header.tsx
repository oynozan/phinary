"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BalancePill } from "@/components/wallet/balance-pill";
import { ConnectButton } from "@/components/wallet/connect-button";
import { cn } from "@/lib/utils";

import { BRAND_NAME } from "@/config/brand";
import { isActivePath, NAV_ITEMS } from "./nav-items";

/** Shared navigation; wallet behavior stays in its existing components. */
export function Header() {
    const pathname = usePathname();

    return (
        <header className="app-header">
            <div className="app-header-inner">
                <Link href="/" aria-label={`${BRAND_NAME} home`} className="header-brand">
                    <svg className="header-brand-mark" width="30" height="32" viewBox="0 0 30 32" fill="none" aria-hidden="true">
                        <defs><linearGradient id="phinary-header-mark" x1="4" y1="3" x2="25" y2="29" gradientUnits="userSpaceOnUse"><stop stopColor="#72ddfa"/><stop offset=".48" stopColor="#9c83fa"/><stop offset="1" stopColor="#bd35f0"/></linearGradient></defs>
                        <path d="M15 7C8.1 7 3 10.5 3 16s5.1 9 12 9 12-3.5 12-9-5.1-9-12-9Z" stroke="url(#phinary-header-mark)" strokeWidth="5"/>
                        <path d="M15 1v30" stroke="url(#phinary-header-mark)" strokeWidth="5"/>
                    </svg>
                    <span>{BRAND_NAME}</span>
                </Link>

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
                                className="header-menu size-8 lg:hidden"
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
