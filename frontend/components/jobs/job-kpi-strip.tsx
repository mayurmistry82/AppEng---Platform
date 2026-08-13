import { KpiStrip, KpiTile } from "@/components/ui/kpi-tile";
import type { KpiTileView } from "@/lib/jobs";

/**
 * Dashboard KPI strip (checklist 3.1) — four tiles composed from the existing
 * KpiStrip + KpiTile. Values arrive pre-formatted from summariseJobs(), which
 * owns the null handling (win_rate null → "—", never "0%"; absent KPI object →
 * four "—" tiles). No deltaSign is passed — all four deltas are neutral
 * muted-foreground captions.
 */
export function JobKpiStrip({ tiles }: { tiles: readonly KpiTileView[] }) {
  return (
    <KpiStrip>
      {tiles.map((tile) => (
        <KpiTile
          key={tile.label}
          label={tile.label}
          value={tile.value}
          delta={tile.delta}
        />
      ))}
    </KpiStrip>
  );
}
