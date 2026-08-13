import Link from "next/link";
import { AlertTriangle, FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { JobRowView } from "@/lib/jobs";

/**
 * Job table (checklist 3.1) — composes the existing table primitives; row
 * height, hover and dividers come from TableRow (h-9, hover:bg-accent,
 * `border` dividers per F33) and are not restyled here.
 *
 * Empty state: only reachable when the request SUCCEEDED with zero jobs — a
 * failed request renders the page-level error panel instead, never this. The
 * two states are produced from different branches and can never be confused.
 */

export function JobTable({
  rows,
  filtersActive,
}: {
  rows: readonly JobRowView[];
  filtersActive: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-16 text-center">
        <h2 className="text-h3 text-foreground">
          {filtersActive ? "No jobs match these filters" : "No jobs yet"}
        </h2>
        <p className="text-body text-muted-foreground">
          {filtersActive
            ? "Try a different filter or clear your search."
            : "Create your first job to get started."}
        </p>
        <div className="mt-2 flex items-center gap-3">
          {filtersActive ? (
            <Button variant="secondary" asChild>
              <Link href="/jobs">Clear filters</Link>
            </Button>
          ) : null}
          {/* The creation modal is checklist 3.2 — until then this button
              deliberately does nothing, same as AppRail's New job control. */}
          <Button>＋ New job</Button>
        </div>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Customer / site</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Accuracy</TableHead>
          <TableHead>Assigned</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead>Updated</TableHead>
          {/* reopen column — no header text */}
          <TableHead aria-label="Open job" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.jobId}>
            <TableCell>
              <div className="text-body text-foreground">{row.customerName}</div>
              <div className="text-caption text-muted-foreground">
                {row.address}
              </div>
            </TableCell>
            <TableCell>
              {/* Raw string straight through — the pill guards unknown values. */}
              <StatusPill status={row.status} />
            </TableCell>
            <TableCell>
              <span
                className={`metric-sm ${
                  row.resultMuted ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                {row.result}
              </span>
            </TableCell>
            <TableCell>
              {/* AccuracyMeter is a 110-190px worksheet component — wrong in a
                  36px row, so the tier renders as plain text + warning icon. */}
              <span className="inline-flex items-center gap-1.5 text-body text-foreground">
                {row.tierLabel}
                {row.tierLow ? (
                  <AlertTriangle
                    className="h-4 w-4 text-warning"
                    role="img"
                    aria-label="Low accuracy — worth improving"
                  />
                ) : null}
              </span>
            </TableCell>
            <TableCell>
              {/* Always "—": assigned_to is a raw auth.users uuid and neither
                  company_members nor a joined installer_profiles.name offers a
                  display name. Mayur decided the name join belongs to 7.2 — do
                  not render the uuid, add a backend join, or drop the column. */}
              <span className="text-body text-muted-foreground">—</span>
            </TableCell>
            <TableCell>
              {/* Display-only — no notes-write endpoint exists yet, so neither
                  icon is clickable; editing is not built. */}
              {row.notes ? (
                <span title={row.notes}>
                  <FileText
                    className="h-4 w-4 text-foreground"
                    role="img"
                    aria-label="Job note"
                  />
                </span>
              ) : (
                <Plus
                  className="h-4 w-4 text-muted-foreground"
                  role="img"
                  aria-label="No notes"
                />
              )}
            </TableCell>
            <TableCell>
              <span className="whitespace-nowrap text-body text-muted-foreground">
                {row.updated}
              </span>
            </TableCell>
            <TableCell className="text-right">
              <Link
                href={row.href}
                className="whitespace-nowrap text-body text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                reopen ›
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
