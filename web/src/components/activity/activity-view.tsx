"use client";
import { useLiveActivity } from "@/lib/activity/use-activity";
import { ActivityScreen } from "./activity-screen";
export function ActivityView() {
    return <ActivityScreen display={useLiveActivity()} />;
}
