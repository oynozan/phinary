"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import {
    AnimatePresence,
    motion,
    useMotionValue,
    useSpring,
    useTransform,
    type MotionValue,
    type SpringOptions,
} from "motion/react";

import { cn } from "@/lib/utils";

import { isActivePath, NAV_ITEMS } from "./nav-items";

const SPRING: SpringOptions = { mass: 0.1, stiffness: 150, damping: 12 };
const DISTANCE = 200;

type Sizes = { panel: number; base: number; magnified: number; icon: number };
const WIDE: Sizes = { panel: 86, base: 56, magnified: 72, icon: 24 };
const NARROW: Sizes = { panel: 70, base: 46, magnified: 58, icon: 22 };

const NARROW_QUERY = "(max-width: 459px)";

function subscribeNarrow(cb: () => void) {
    const mq = window.matchMedia(NARROW_QUERY);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
}

function useNarrow() {
    return useSyncExternalStore(
        subscribeNarrow,
        () => window.matchMedia(NARROW_QUERY).matches,
        () => false,
    );
}

function DockItem({
    href,
    label,
    active,
    mouseX,
    sizes,
    children,
}: {
    href: string;
    label: string;
    active: boolean;
    mouseX: MotionValue<number>;
    sizes: Sizes;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLAnchorElement>(null);
    const [hovered, setHovered] = useState(false);

    const distance = useTransform(mouseX, (x) => {
        const rect = ref.current?.getBoundingClientRect() ?? { x: 0, width: sizes.base };
        return x - rect.x - sizes.base / 2;
    });
    const target = useTransform(distance, [-DISTANCE, 0, DISTANCE], [sizes.base, sizes.magnified, sizes.base]);
    const size = useSpring(target, SPRING);

    return (
        <motion.div style={{ width: size, height: size }} className="relative">
            <Link
                ref={ref}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setHovered(true)}
                onBlur={() => setHovered(false)}
                className={cn(
                    "flex size-full items-center justify-center rounded-full border shadow-md transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring",
                    active ? "border-primary bg-primary-soft text-primary" : "bg-surface-2 text-white hover:bg-surface-3 hover:text-primary",
                )}
            >
                {children}
            </Link>
            <AnimatePresence>
                {hovered && (
                    <motion.div
                        initial={{ opacity: 0, y: 0 }}
                        animate={{ opacity: 1, y: -10 }}
                        exit={{ opacity: 0, y: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ x: "-50%" }}
                        role="tooltip"
                        className="pointer-events-none absolute -top-6 left-1/2 w-fit rounded-md border bg-surface-2 px-2 py-0.5 font-secondary text-xs whitespace-pre text-white"
                    >
                        {label}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

/** Floating bottom dock with magnification (atomic.cash). Primary nav on mobile, shortcut bar on desktop. */
export function Dock() {
    const pathname = usePathname();
    const sizes = useNarrow() ? NARROW : WIDE;
    const mouseX = useMotionValue(Infinity);
    const isHovered = useMotionValue(0);
    const maxHeight = Math.max(256, sizes.magnified * 1.5 + 4);
    const heightRow = useTransform(isHovered, [0, 1], [sizes.panel, maxHeight]);
    const height = useSpring(heightRow, SPRING);

    return (
        <nav
            aria-label="Dock"
            className="pointer-events-none fixed right-0 bottom-4 left-0 z-50 flex max-w-[100vw] justify-center overflow-hidden lg:hidden"
        >
            <motion.div style={{ height }} className="relative mx-2 flex max-w-full items-center">
                <motion.div
                    onMouseMove={({ clientX }) => {
                        isHovered.set(1);
                        mouseX.set(clientX);
                    }}
                    onMouseLeave={() => {
                        isHovered.set(0);
                        mouseX.set(Infinity);
                    }}
                    style={{ height: sizes.panel }}
                    className="pointer-events-auto absolute bottom-0 left-1/2 flex w-fit -translate-x-1/2 items-end gap-3 rounded-full border bg-surface px-4 pb-3 sm:gap-4"
                >
                    {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
                        <DockItem key={href} href={href} label={label} active={isActivePath(pathname, href)} mouseX={mouseX} sizes={sizes}>
                            <Icon size={sizes.icon} />
                        </DockItem>
                    ))}
                </motion.div>
            </motion.div>
        </nav>
    );
}
