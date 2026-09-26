import type { MetaRecord } from "nextra";

const pageTheme = {
    breadcrumb: false,
    timestamp: false,
    copyPage: false,
};

const meta: MetaRecord = {
    "*": { theme: pageTheme },
    "uniswap-app": "Trade in the Uniswap app",
    troubleshooting: "Troubleshooting",
    liquidity: "Provide liquidity",
    "run-locally": "Run the demo locally",
};

export default meta;
