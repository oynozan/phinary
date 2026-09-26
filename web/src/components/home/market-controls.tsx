import { Search, ChevronDown } from "lucide-react";
import type { MarketTab } from "@/lib/phase";
import type {
  ExplorerFilters,
  MarketSort,
  TrackFilter as TrackFilterValue,
} from "@/lib/markets/explorer";
export const MARKET_TABS: { value: MarketTab; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "upcoming", label: "Upcoming" },
  { value: "resolved", label: "Resolved" },
];
/** Optional asset and duration filters: "All" by default, clicking the active pill clears it */
export function TrackFilter({
  value,
  onChange,
  assets,
  durations,
}: {
  value: TrackFilterValue;
  onChange: (next: TrackFilterValue) => void;
  assets: string[];
  durations: string[];
}) {
  if (!assets.length && !durations.length)
    return <div className="track-filter" aria-hidden="true" />;
  return (
    <div className="track-filter">
      <div role="group" aria-label="Asset">
        {["all", ...assets].map((a) => (
          <button
            type="button"
            key={a}
            aria-pressed={value.underlying === a}
            onClick={() =>
              onChange({
                ...value,
                underlying: value.underlying === a ? "all" : a,
              })
            }
          >
            {a === "all" ? "All" : a}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Duration">
        {["all", ...durations].map((d) => (
          <button
            type="button"
            key={d}
            aria-pressed={value.track === d}
            onClick={() =>
              onChange({ ...value, track: value.track === d ? "all" : d })
            }
          >
            {d === "all" ? "All" : d}
          </button>
        ))}
      </div>
    </div>
  );
}
export function MarketControls({
  filters,
  onChange,
  volumeAvailable,
}: {
  filters: ExplorerFilters;
  onChange: (next: ExplorerFilters) => void;
  volumeAvailable: boolean;
}) {
  return (
    <div className="market-controls">
      <div className="market-utilities">
        <div
          className="market-state-controls"
          role="group"
          aria-label="Market status"
        >
          {MARKET_TABS.map((t) => (
            <button
              type="button"
              key={t.value}
              aria-pressed={filters.tab === t.value}
              onClick={() => onChange({ ...filters, tab: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="market-search">
          <Search size={16} />
          <span className="sr-only">Search markets</span>
          <input
            type="search"
            placeholder="Search markets..."
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
          />
        </label>
        <label className="market-sort">
          <span>Sort by</span>
          <span className="market-select">
            <select
              aria-label="Sort markets"
              value={volumeAvailable ? filters.sort : "deadline"}
              onChange={(e) =>
                onChange({ ...filters, sort: e.target.value as MarketSort })
              }
            >
              <option value="deadline">
                {filters.tab === "resolved"
                  ? "Latest"
                  : filters.tab === "upcoming"
                    ? "Opening"
                    : "Ending soon"}
              </option>
              <option value="volume" disabled={!volumeAvailable}>
                Volume{!volumeAvailable ? " (N/A)" : ""}
              </option>
            </select>
            <ChevronDown size={14} />
          </span>
        </label>
      </div>
    </div>
  );
}
