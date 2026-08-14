import { Pencil } from "lucide-react";
import { AccuracyMeter } from "@/components/ui/accuracy-meter";
import { StatusPill } from "@/components/ui/status-pill";
import type { JobBarView } from "@/lib/worksheet";

/**
 * Job bar (checklist 3.3) — the row ABOVE the JobTabs, from wireframe v4
 * Variant A `.topbar`. Server component; everything interactive on it is
 * deliberately inert at 3.3:
 *
 *   - the pencil is DISABLED — editing job details is 3.3c (F82)
 *   - Residential|C&I holds no state; there is no jobs column for it, C&I
 *     sizing is 10.5 — both segments render disabled, C&I with its reason
 *     (visible-but-disabled, the same D1 treatment the new-job dialog gives
 *     paths C and D)
 *   - Save / Report are DISABLED with titles naming their rows (3.4+ / 8.1) —
 *     never live buttons that silently do nothing
 */
export function JobBar({ view }: { view: JobBarView }) {
  return (
    <div className="border-b border-border bg-card px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-h3 text-foreground">{view.address}</h1>

        <StatusPill status={view.statusRaw} />

        <span className="inline-flex items-center gap-1 text-body text-muted-foreground">
          {view.jobTypeLabel}
          <button
            type="button"
            disabled
            title="Editing job details arrives at 3.3c"
            className="rounded p-0.5 text-muted-foreground opacity-50"
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="sr-only">Editing job details arrives at 3.3c</span>
          </button>
        </span>

        {/* Residential | C&I — presentational only; no jobs column exists. */}
        <span className="inline-flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled
              aria-pressed="true"
              className="rounded-md bg-primary-solid px-2.5 py-1 text-caption text-primary-foreground"
            >
              Residential
            </button>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="rounded-md border border-border-subtle px-2.5 py-1 text-caption text-text-disabled"
            >
              C&amp;I
            </button>
          </span>
          <span className="text-caption text-muted-foreground">
            C&amp;I sizing is not built yet — residential only for now.
          </span>
        </span>

        <AccuracyMeter tier={view.tier} className="w-[150px]" />

        <span className="flex-1" />

        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            disabled
            title="Nothing to save until a section is built (3.4+)"
            className="rounded-md bg-primary-solid px-4 py-1.5 text-button text-primary-foreground opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled
            title="Report generation arrives at 8.1"
            className="rounded-md border border-border px-4 py-1.5 text-button text-foreground opacity-50"
          >
            Report
          </button>
        </span>
      </div>
    </div>
  );
}
