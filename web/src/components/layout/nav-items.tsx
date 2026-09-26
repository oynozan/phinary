import { Activity, ChartNoAxesColumnIncreasing, Landmark, Wallet } from "lucide-react";

export const NAV_ITEMS = [
    { label: "Markets", href: "/", icon: ChartNoAxesColumnIncreasing },
    { label: "Portfolio", href: "/portfolio", icon: Wallet },
    { label: "Activity", href: "/activity", icon: Activity },
    { label: "Vault", href: "/vault", icon: Landmark },
] as const;

/** "/" only matches itself; other items also match their sub-routes. */
export function isActivePath(pathname: string, href: string) {
    if (href === "/") return pathname === "/" || pathname.startsWith("/market/");
    return pathname === href || pathname.startsWith(`${href}/`);
}
