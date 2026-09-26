import type { MetaRecord } from "nextra";

const pageTheme = {
    breadcrumb: false,
    timestamp: false,
    copyPage: false,
};

const meta: MetaRecord = {
    "*": { theme: pageTheme },
    "prediction-hook": "PredictionHook",
    pricing: "Pricing math",
    oracle: "Oracle",
    scheduler: "Scheduler",
};

export default meta;
