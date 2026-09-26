import type { MetaRecord } from "nextra";

const pageTheme = {
    breadcrumb: false,
    timestamp: false,
    copyPage: false,
};

const meta: MetaRecord = {
    "*": { theme: pageTheme },
    index: "Overview",
    "quote-and-swap": "Quote and swap",
    events: "Events and indexing",
    "keeper-calls": "Keeper calls",
};

export default meta;
