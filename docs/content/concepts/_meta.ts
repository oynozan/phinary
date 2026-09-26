import type { MetaRecord } from "nextra";

const pageTheme = {
    breadcrumb: false,
    timestamp: false,
    copyPage: false,
};

const meta: MetaRecord = {
    "*": { theme: pageTheme },
    "binary-markets": "Binary markets",
    pricing: "Pricing, simply",
    settlement: "Settlement",
    vault: "The LP vault",
    glossary: "Glossary",
    faq: "FAQ",
};

export default meta;
