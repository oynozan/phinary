import { PositionsTable } from "./positions";
import type { ComponentProps } from "react";
export function HistoryTable(props: Omit<ComponentProps<typeof PositionsTable>, "section">) {
    return <PositionsTable {...props} section="history" />;
}
