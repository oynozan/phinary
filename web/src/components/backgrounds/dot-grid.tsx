"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { InertiaPlugin } from "gsap/InertiaPlugin";

import { cn } from "@/lib/utils";

gsap.registerPlugin(InertiaPlugin);

// Adapted from ReactBits DotGrid (https://reactbits.dev/backgrounds/dot-grid)

interface Dot {
    cx: number;
    cy: number;
    xOffset: number;
    yOffset: number;
    pushed: boolean;
}

export interface DotGridProps {
    dotSize?: number;
    gap?: number;
    baseColor?: string;
    activeColor?: string;
    proximity?: number;
    speedTrigger?: number;
    shockRadius?: number;
    shockStrength?: number;
    maxSpeed?: number;
    resistance?: number;
    returnDuration?: number;
    className?: string;
}

function hexToRgb(hex: string) {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/**
 * Full-viewport canvas of dots that light up near the cursor and scatter on fast moves and clicks.
 * Pointer events are read on window, so the canvas never blocks the content above it.
 * With prefers-reduced-motion the dots are drawn once and stay still.
 */
export function DotGrid({
    dotSize = 3,
    gap = 26,
    baseColor = "#333035",
    activeColor = "#C828D6",
    proximity = 130,
    speedTrigger = 120,
    shockRadius = 220,
    shockStrength = 4,
    maxSpeed = 5000,
    resistance = 750,
    returnDuration = 1.5,
    className,
}: DotGridProps) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const wrap = wrapperRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!wrap || !canvas || !ctx) return;

        const base = hexToRgb(baseColor);
        const active = hexToRgb(activeColor);
        const circle = new Path2D();
        circle.arc(0, 0, dotSize / 2, 0, Math.PI * 2);
        const proxSq = proximity * proximity;

        const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        let dots: Dot[] = [];
        const pointer = { x: -1e4, y: -1e4, lastX: 0, lastY: 0, lastTime: 0 };
        let raf = 0;

        const draw = () => {
            raf = 0;
            const { width, height } = canvas;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, width, height);
            const dpr = window.devicePixelRatio || 1;
            let moving = false;

            for (const dot of dots) {
                if (dot.pushed || dot.xOffset !== 0 || dot.yOffset !== 0) moving = true;
                const dx = dot.cx - pointer.x;
                const dy = dot.cy - pointer.y;
                const dsq = dx * dx + dy * dy;
                let fill = baseColor;
                if (dsq <= proxSq) {
                    const t = 1 - Math.sqrt(dsq) / proximity;
                    fill = `rgb(${Math.round(base.r + (active.r - base.r) * t)},${Math.round(base.g + (active.g - base.g) * t)},${Math.round(base.b + (active.b - base.b) * t)})`;
                }
                ctx.setTransform(dpr, 0, 0, dpr, (dot.cx + dot.xOffset) * dpr, (dot.cy + dot.yOffset) * dpr);
                ctx.fillStyle = fill;
                ctx.fill(circle);
            }

            // Keep animating only while dots are still returning to rest
            if (moving) schedule();
        };

        const schedule = () => {
            if (!raf) raf = requestAnimationFrame(draw);
        };

        const build = () => {
            const { width, height } = wrap.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);

            const cell = dotSize + gap;
            const cols = Math.floor((width + gap) / cell);
            const rows = Math.floor((height + gap) / cell);
            const startX = (width - (cell * cols - gap)) / 2 + dotSize / 2;
            const startY = (height - (cell * rows - gap)) / 2 + dotSize / 2;

            for (const dot of dots) gsap.killTweensOf(dot);
            dots = [];
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    dots.push({ cx: startX + x * cell, cy: startY + y * cell, xOffset: 0, yOffset: 0, pushed: false });
                }
            }
            schedule();
        };

        const push = (dot: Dot, pushX: number, pushY: number) => {
            dot.pushed = true;
            gsap.killTweensOf(dot);
            gsap.to(dot, {
                inertia: { xOffset: pushX, yOffset: pushY, resistance },
                onComplete: () => {
                    gsap.to(dot, { xOffset: 0, yOffset: 0, duration: returnDuration, ease: "elastic.out(1,0.75)" });
                    dot.pushed = false;
                },
            });
            schedule();
        };

        const onMove = (e: PointerEvent) => {
            if (e.pointerType !== "mouse" || motionQuery.matches) return;
            const now = performance.now();
            if (now - pointer.lastTime < 16) return;
            const dt = pointer.lastTime ? now - pointer.lastTime : 16;
            let vx = ((e.clientX - pointer.lastX) / dt) * 1000;
            let vy = ((e.clientY - pointer.lastY) / dt) * 1000;
            let speed = Math.hypot(vx, vy);
            if (speed > maxSpeed) {
                vx *= maxSpeed / speed;
                vy *= maxSpeed / speed;
                speed = maxSpeed;
            }
            pointer.lastTime = now;
            pointer.lastX = e.clientX;
            pointer.lastY = e.clientY;

            const rect = canvas.getBoundingClientRect();
            pointer.x = e.clientX - rect.left;
            pointer.y = e.clientY - rect.top;

            if (speed > speedTrigger) {
                for (const dot of dots) {
                    if (dot.pushed || Math.hypot(dot.cx - pointer.x, dot.cy - pointer.y) >= proximity) continue;
                    push(dot, dot.cx - pointer.x + vx * 0.005, dot.cy - pointer.y + vy * 0.005);
                }
            }
            schedule();
        };

        const onLeave = () => {
            pointer.x = -1e4;
            pointer.y = -1e4;
            schedule();
        };

        const onClick = (e: MouseEvent) => {
            if (motionQuery.matches) return;
            const rect = canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            for (const dot of dots) {
                const dist = Math.hypot(dot.cx - cx, dot.cy - cy);
                if (dist >= shockRadius || dot.pushed) continue;
                const falloff = 1 - dist / shockRadius;
                push(dot, (dot.cx - cx) * shockStrength * falloff, (dot.cy - cy) * shockStrength * falloff);
            }
        };

        const onMotionChange = () => {
            if (motionQuery.matches) {
                for (const dot of dots) {
                    gsap.killTweensOf(dot);
                    dot.xOffset = 0;
                    dot.yOffset = 0;
                    dot.pushed = false;
                }
                onLeave();
            }
        };

        build();
        const ro = new ResizeObserver(build);
        ro.observe(wrap);
        window.addEventListener("pointermove", onMove, { passive: true });
        document.documentElement.addEventListener("pointerleave", onLeave);
        window.addEventListener("click", onClick);
        motionQuery.addEventListener("change", onMotionChange);

        return () => {
            ro.disconnect();
            window.removeEventListener("pointermove", onMove);
            document.documentElement.removeEventListener("pointerleave", onLeave);
            window.removeEventListener("click", onClick);
            motionQuery.removeEventListener("change", onMotionChange);
            if (raf) cancelAnimationFrame(raf);
            for (const dot of dots) gsap.killTweensOf(dot);
        };
    }, [
        dotSize,
        gap,
        baseColor,
        activeColor,
        proximity,
        speedTrigger,
        shockRadius,
        shockStrength,
        maxSpeed,
        resistance,
        returnDuration,
    ]);

    return (
        <div ref={wrapperRef} aria-hidden className={cn("pointer-events-none fixed inset-0 -z-10", className)}>
            <canvas ref={canvasRef} className="absolute inset-0 size-full" />
        </div>
    );
}
