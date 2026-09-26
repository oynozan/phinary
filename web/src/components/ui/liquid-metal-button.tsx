"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
    getShaderColorFromString,
    liquidMetalFragmentShader,
    LiquidMetalShapes,
    ShaderMount,
} from "@paper-design/shaders";

import { cn } from "@/lib/utils";

interface LiquidMetalButtonProps {
    label?: string;
    fullWidth?: boolean;
    disabled?: boolean;
    title?: string;
    type?: "button" | "submit";
    className?: string;
    onClick?: () => void;
    viewMode?: "text" | "icon";
    href?: string;
}

/** Orchid color-burn tint over the chrome. Every layer under it is a flat opaque colour. */
const TINT = getShaderColorFromString("#d24bdf");
const TINT_STRENGTH = 0.85;
const SURFACE = "#5f1d67";
const SURFACE_HOVER = "#6e2177";
const SURFACE_DISABLED = "#3a2a3d";
const RIM_FILL = "#9c30a5";
const RIM_DISABLED = "#4f3e52";
const EASE = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const RIM = 2;

const STYLE_ID = "liquid-metal-style";
const STYLE = `
.liquid-metal-shader canvas {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  position: absolute !important;
  inset: 0 !important;
  border-radius: 9999px !important;
}`;

const SPEED_IDLE = 0.6;
const SPEED_HOVER = 1;
const SPEED_PRESS = 2.4;

/**
 * The primary Trade CTA: a pill with a moving liquid-metal rim tinted orchid.
 * Full width it matches the 56px pill buttons; inline it is 46px tall.
 */
export function LiquidMetalButton({
    label = "Trade",
    onClick,
    viewMode = "text",
    fullWidth = false,
    disabled = false,
    title,
    type = "button",
    className,
    href,
}: LiquidMetalButtonProps) {
    const [isHovered, setIsHovered] = useState(false);
    const [isPressed, setIsPressed] = useState(false);
    const shaderRef = useRef<HTMLDivElement>(null);
    const shaderMount = useRef<ShaderMount | null>(null);
    const hoveredRef = useRef(false);

    const height = viewMode === "icon" ? 46 : fullWidth ? 56 : 46;
    const width = viewMode === "icon" ? 46 : 142;
    const outerWidth = fullWidth && viewMode === "text" ? "100%" : `${width}px`;

    useEffect(() => {
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = STYLE;
            document.head.appendChild(style);
        }
        if (!shaderRef.current) return;
        try {
            shaderMount.current = new ShaderMount(
                shaderRef.current,
                liquidMetalFragmentShader,
                {
                    u_repetition: 4,
                    u_softness: 0.5,
                    u_shiftRed: 0.3,
                    u_shiftBlue: 0.3,
                    u_distortion: 0,
                    u_contour: 0,
                    u_angle: 45,
                    u_scale: 8,
                    u_shape: LiquidMetalShapes.none,
                    u_originX: 0.5,
                    u_originY: 0.5,
                    u_offsetX: 0,
                    u_offsetY: 0,
                    u_colorBack: [0, 0, 0, 0],
                    u_colorTint: [TINT[0], TINT[1], TINT[2], TINT_STRENGTH],
                },
                undefined,
                SPEED_IDLE,
            );
        } catch {
            // No WebGL: the CSS surface and rim below still render a usable button.
            shaderMount.current = null;
        }
        return () => {
            shaderMount.current?.dispose();
            shaderMount.current = null;
        };
    }, []);

    const setSpeed = (speed: number) => shaderMount.current?.setSpeed?.(speed);

    function handleMouseEnter() {
        hoveredRef.current = true;
        setIsHovered(true);
        setSpeed(SPEED_HOVER);
    }

    function handleMouseLeave() {
        hoveredRef.current = false;
        setIsHovered(false);
        setIsPressed(false);
        setSpeed(SPEED_IDLE);
    }

    function handleClick(e: React.MouseEvent<HTMLElement>) {
        if (disabled) {
            e.preventDefault();
            return;
        }
        setSpeed(SPEED_PRESS);
        setTimeout(() => setSpeed(hoveredRef.current ? SPEED_HOVER : SPEED_IDLE), 300);
        onClick?.();
    }

    const layer: React.CSSProperties = {
        position: "absolute",
        inset: 0,
        borderRadius: 9999,
        transition: `all 0.8s ${EASE}, width 0.4s ease, height 0.4s ease`,
    };

    const shadow = isPressed ? "0 0 0 1px rgba(0,0,0,0.5)" : "0 0 0 1px rgba(0,0,0,0.3), 0 2px 5px rgba(0,0,0,0.15)";
    const surface = disabled ? SURFACE_DISABLED : isHovered ? SURFACE_HOVER : SURFACE;

    const shared = {
        title,
        onClick: handleClick,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        onMouseDown: () => setIsPressed(true),
        onMouseUp: () => setIsPressed(false),
        "aria-label": label,
        className: "absolute inset-0 z-40 overflow-hidden rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/60",
        style: { cursor: disabled ? "not-allowed" : "pointer" } as React.CSSProperties,
    };

    return (
        <div
            className={cn("liquid-metal", className)}
            style={{ isolation: "isolate", width: fullWidth ? "100%" : undefined }}
        >
            <div style={{ position: "relative", width: outerWidth, height }}>
                {viewMode === "text" && (
                    <div
                        style={{
                            ...layer,
                            zIndex: 30,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            pointerEvents: "none",
                        }}
                    >
                        <span
                            className="font-sans"
                            style={{
                                fontSize: fullWidth ? 18 : 14,
                                fontWeight: 500,
                                color: disabled ? "#cfc6d1" : "#fdfdfd",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {label}
                        </span>
                    </div>
                )}

                <div style={{ ...layer, zIndex: 20 }}>
                    <div
                        style={{
                            position: "absolute",
                            inset: RIM,
                            borderRadius: 9999,
                            backgroundColor: surface,
                            boxShadow: isPressed ? "inset 0 2px 4px rgba(0,0,0,0.4)" : "none",
                            transition: "background-color 0.3s ease, box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
                        }}
                    />
                </div>

                <div style={{ ...layer, zIndex: 10, boxShadow: shadow, backgroundColor: disabled ? RIM_DISABLED : RIM_FILL }}>
                    <div
                        ref={shaderRef}
                        className="liquid-metal-shader"
                        style={{
                            position: "relative",
                            width: "100%",
                            height: "100%",
                            borderRadius: 9999,
                            overflow: "hidden",
                            visibility: disabled ? "hidden" : "visible",
                        }}
                    />
                </div>

                {href && !disabled ? (
                    <Link href={href} {...shared} />
                ) : (
                    <button type={type} disabled={disabled} {...shared} />
                )}
            </div>
        </div>
    );
}
