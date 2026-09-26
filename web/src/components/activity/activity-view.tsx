"use client";
import { useActivity, useLeaderboard } from "@/lib/data";
import { ActivityScreen } from "./activity-screen";
/** These hooks have no indexed source yet. Never infer accounting from market snapshots. */
export function ActivityView() {
    const feed = useActivity(12), board = useLeaderboard(10);
    return <ActivityScreen display={{ status: feed.isLoading || board.isLoading ? 'loading' : 'unavailable', snapshot: null }}/>;
}
