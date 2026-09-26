import type { MetaRecord } from "nextra";

const pageTheme = {
    breadcrumb: false,
    timestamp: false,
    copyPage: false,
};

const meta: MetaRecord = {
    "*": { theme: pageTheme },
    index: "Introduction",
    guides: "Guides",
    concepts: "Concepts",
    contracts: "Contracts",
    integration: "Integration",
};

export default meta;
