import type { MetaRecord } from "nextra";

const meta: MetaRecord = {
    index: {
        type: "page",
        display: "hidden",
        theme: {
            layout: "full",
            sidebar: false,
            toc: false,
            breadcrumb: false,
            pagination: false,
            timestamp: false,
            copyPage: false,
        },
    },
};

export default meta;
