import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * StatusPill — the six job statuses (DESIGN.md `components: status-pill`).
 * Composition: dot in `status-X` + background `status-X-bg` + label in
 * `status-X-foreground`, fully rounded, `caption` type role.
 *
 * BORDERLESS BY DESIGN. DESIGN.md's composition lists dot + bg + label only, and
 * F33 notes `status-draft-bg` in dark resolves to the same value as
 * `border-subtle`, so a subtle border would be invisible on the draft pill
 * anyway. The `-bg` fills already separate the pill from `card`/`background` in
 * both modes, so no border is needed to define the shape.
 *
 * Class strings are written out per status rather than interpolated: Tailwind
 * scans source statically, so `bg-status-${x}-bg` would never be generated.
 */

export type JobStatus = "draft" | "sized" | "sent" | "won" | "installed" | "lost";

const STATUS_STYLES: Record<
  JobStatus,
  { dot: string; pill: string; label: string }
> = {
  draft: {
    dot: "bg-status-draft",
    pill: "bg-status-draft-bg",
    label: "text-status-draft-foreground",
  },
  sized: {
    dot: "bg-status-sized",
    pill: "bg-status-sized-bg",
    label: "text-status-sized-foreground",
  },
  sent: {
    dot: "bg-status-sent",
    pill: "bg-status-sent-bg",
    label: "text-status-sent-foreground",
  },
  won: {
    dot: "bg-status-won",
    pill: "bg-status-won-bg",
    label: "text-status-won-foreground",
  },
  installed: {
    dot: "bg-status-installed",
    pill: "bg-status-installed-bg",
    label: "text-status-installed-foreground",
  },
  lost: {
    dot: "bg-status-lost",
    pill: "bg-status-lost-bg",
    label: "text-status-lost-foreground",
  },
};

const LABELS: Record<JobStatus, string> = {
  draft: "Draft",
  sized: "Sized",
  sent: "Sent",
  won: "Won",
  installed: "Installed",
  lost: "Lost",
};

function isJobStatus(value: string): value is JobStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_STYLES, value);
}

export interface StatusPillProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  /** Accepts any string so unvalidated API data cannot crash the UI. */
  status: JobStatus | (string & {});
}

const StatusPill = React.forwardRef<HTMLSpanElement, StatusPillProps>(
  ({ status, className, children, ...props }, ref) => {
    // An unknown status falls back to draft styling rather than throwing.
    const key: JobStatus =
      typeof status === "string" && isJobStatus(status) ? status : "draft";
    const styles = STATUS_STYLES[key];

    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption",
          styles.pill,
          styles.label,
          className,
        )}
        {...props}
      >
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", styles.dot)}
        />
        {children ?? LABELS[key]}
      </span>
    );
  },
);
StatusPill.displayName = "StatusPill";

export { StatusPill };
