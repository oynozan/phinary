import type { Metadata, Viewport } from "next";
import { Akt, Lexend_Deca, Manrope, Ubuntu_Mono } from "next/font/google";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { Layout, Navbar } from "nextra-theme-docs";

import "nextra-theme-docs/style.css";
import "./globals.css";

const akt = Akt({ variable: "--font-akt", weight: ["400", "500"], subsets: ["latin"], display: "swap", fallback: ["system-ui", "sans-serif"] });
const lexendDeca = Lexend_Deca({ variable: "--font-lexend-deca", weight: ["300", "400", "500", "600"], subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });
const ubuntuMono = Ubuntu_Mono({ variable: "--font-ubuntu-mono", weight: ["400", "700"], subsets: ["latin"] });

export const metadata: Metadata = {
    title: { default: "Phinary Docs", template: "%s · Phinary Docs" },
    description: "Binary prediction markets on Uniswap v4. No external oracles, no external services.",
};

export const viewport: Viewport = {
    colorScheme: "dark",
};

const navbar = <Navbar logo={<span className="wordmark">Phinary</span>} />;

export default async function RootLayout({ children }: LayoutProps<"/">) {
    return (
        <html
            lang="en"
            dir="ltr"
            className={`dark ${akt.variable} ${lexendDeca.variable} ${manrope.variable} ${ubuntuMono.variable}`}
            suppressHydrationWarning
        >
            <Head
                color={{ hue: 295, saturation: 69, lightness: 50 }}
                backgroundColor={{ dark: "#191919", light: "#191919" }}
            />
            <body>
                <Layout
                    navbar={navbar}
                    pageMap={await getPageMap()}
                    docsRepositoryBase="https://github.com/oynozan/phinary/tree/main/docs"
                    darkMode={false}
                    nextThemes={{ defaultTheme: "dark", forcedTheme: "dark" }}
                    feedback={{ content: null }}
                    editLink={null}
                >
                    {children}
                </Layout>
            </body>
        </html>
    );
}
