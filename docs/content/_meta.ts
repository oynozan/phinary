import type { MetaRecord } from "nextra";

const theme = {
    breadcrumb: false,
    timestamp: false,
    copyPage: false,
};

const meta: MetaRecord = {
    index: { title: "PredictionHook", theme },
    pricing: { title: "Pricing", theme },
    oracle: { title: "Oracle", theme },
    scheduler: { title: "Scheduler", theme },
    integration: { title: "Integration", theme },
};

export default meta;
