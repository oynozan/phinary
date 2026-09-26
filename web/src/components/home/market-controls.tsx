import { Search, ChevronDown } from "lucide-react";
import type { MarketTab } from "@/lib/phase";
import type { ExplorerFilters, MarketSort } from "@/lib/markets/explorer";
export const MARKET_TABS: { value: MarketTab; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "upcoming", label: "Upcoming" },
  { value: "resolved", label: "Resolved" },
];
/** Asset and duration pills, one market track is shown at a time */
export function TrackFilter({
  filters,
  onChange,
  assets,
  durations,
}: {
  filters: ExplorerFilters;
  onChange: (next: ExplorerFilters) => void;
  assets: string[];
  durations: string[];
}) {
  return (
    <div className="track-filter">
      <div role="group" aria-label="Asset">
        {assets.map((a) => (
          <button
            type="button"
            key={a}
            aria-pressed={filters.underlying === a}
            onClick={() => onChange({ ...filters, underlying: a })}
          >
            {a}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Duration">
        {durations.map((d) => (
          <button
            type="button"
            key={d}
            aria-pressed={filters.track === d}
            onClick={() => onChange({ ...filters, track: d })}
          >
            {d}
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
