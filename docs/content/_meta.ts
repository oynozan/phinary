import type { MetaRecord } from "nextra";

const meta: MetaRecord = {
    index: {
        type: "page",
        display: "hidden",
        theme: {
            sidebar: false,
            toc: true,
            breadcrumb: false,
            pagination: false,
            timestamp: false,
            copyPage: false,
        },
    },
};

export default meta;
