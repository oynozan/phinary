"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef } from "react";
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
    const header = useRef<HTMLElement>(null);

    useEffect(() => {
        let frame = 0;
        const update = () => {
            frame = 0;
            // Only the backdrop fades; navigation and wallet controls stay opaque.
            const progress = Math.min(1, Math.max(0, window.scrollY) / 96);
            header.current?.style.setProperty("--header-background-alpha", String(progress));
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };
        update();
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            window.removeEventListener("scroll", onScroll);
            cancelAnimationFrame(frame);
        };
    }, []);

    return (
        <header ref={header} className="app-header">
            <div className="app-header-inner">
                <Link href="/" aria-label={`${BRAND_NAME} home`} className="header-brand">
                    <Image className="header-brand-mark" src="/wallets/phinary.svg" width={32} height={32} alt="" />
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
