import Link from "next/link";
import { AlertTriangle, FileText, Plus } from "lucide-react";
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
 * Rows only (F75): the zero-rows empty state is owned by app/(app)/jobs/
 * page.tsx, which renders this component solely when rows exist — its ＋ New
 * job button had to open the 3.2 modal, so the page took the branch and the
 * copy lives there. Empty-vs-error reachability is unchanged: a successful
 * response with zero jobs renders the page's empty state, every failure
 * renders the page's error panel.
 */

export function JobTable({ rows }: { rows: readonly JobRowView[] }) {
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
              {/* The metric treatment (metric-sm, 18px/600) is for a REAL
                  FIGURE — the row's headline number, the same emphasis the
                  KPI tiles use. The "— not yet sized" placeholder is not a
                  figure and renders at the table's own body size instead.
                  resultEmphasis carries that decision from the logic layer
                  (lib/jobs.ts) — this component owns the CSS, not the
                  classification. text-body is stated explicitly rather than
                  left to inherit from the table root: a size beside a colour
                  now survives the class merge (lib/utils.ts), so stating it
                  here is both safe and makes the placeholder's size a fact
                  readable at the call site instead of an inherited default
                  three components away. resultMuted is UNCHANGED — it still
                  owns colour alone. */}
              <span
                className={`${
                  row.resultEmphasis === "metric" ? "metric-sm" : "text-body"
                } ${row.resultMuted ? "text-muted-foreground" : "text-foreground"}`}
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
