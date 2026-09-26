import type { Metadata, Viewport } from "next";
import { Akt, Lexend_Deca, Manrope, Ubuntu_Mono } from "next/font/google";

import { Dock } from "@/components/layout/dock";
import { Header } from "@/components/layout/header";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@/components/wallet/privy-provider";
import { WrongNetworkBanner } from "@/components/wallet/wrong-network-banner";
import { BRAND_NAME } from "@/config/brand";

import "./globals.css";

const akt = Akt({ variable: "--font-akt", subsets: ["latin"], display: "swap", fallback: ["system-ui", "sans-serif"] });
const lexendDeca = Lexend_Deca({ variable: "--font-lexend-deca", subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const ubuntuMono = Ubuntu_Mono({ variable: "--font-ubuntu-mono", weight: ["400", "700"], subsets: ["latin"] });

export const metadata: Metadata = {
    title: { default: `${BRAND_NAME}: ETH prediction markets`, template: `%s · ${BRAND_NAME}` },
    description: "Binary ETH prediction markets priced by Black-Scholes on Uniswap v4.",
};

export const viewport: Viewport = {
    themeColor: "#080b12",
    colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
    return (
        <html
            lang="en"
            className={`dark ${akt.variable} ${lexendDeca.variable} ${manrope.variable} ${ubuntuMono.variable} antialiased`}
        >
            <body>
                <WalletProvider><TooltipProvider>
                    <Header />
                    <main className="relative min-w-0 overflow-x-clip pt-(--shell-top) pb-(--shell-bottom)">
                        <WrongNetworkBanner />
                        {children}
                    </main>
                    <Dock />
                    <Toaster position="top-center" offset={{ top: 120 }} mobileOffset={{ top: 88 }} />
                </TooltipProvider></WalletProvider>
            </body>
        </html>
    );
}
