"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActivePath, NAV_ITEMS } from "./nav-items";

/** Persistent labels make the primary mobile navigation usable without hover. */
export function Dock() {
    const pathname = usePathname();

    return (
        <nav aria-label="Dock" className="app-dock lg:hidden">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
                <Link
                    key={href}
                    href={href}
                    aria-current={isActivePath(pathname, href) ? "page" : undefined}
                    className="app-dock-link"
                >
                    <Icon size={21} aria-hidden="true" />
                    <span>{label}</span>
                </Link>
            ))}
        </nav>
    );
}
