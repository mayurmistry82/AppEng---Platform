import * as React from "react";
import { Clock, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * NoticeCaption — DESIGN.md `notice-caption` (added 2026-08-17 for 3.6, D25).
 *
 * The QUIET level below `notice`: a fact about how the tool WORKS, not a
 * finding about this job. D25's one question decides which a thing is — could
 * this ever NOT fire on a job like this one? No → caption. Yes → notice.
 *
 * A plain <p> — no role, because it is page copy, not an announcement. No
 * border, no fill, no bold title: the ABSENCE of a container is what makes it
 * read quieter than a notice without being hard to read. Never colour-coded
 * and it NEVER accepts a tone — the moment it has tones it is a second notice
 * scale, which is exactly the F96 failure one level down. It is also never
 * collapsed or hidden (D4: hide controls, never information).
 *
 * Icon: Info for a method fact, Clock for an age/recency fact — never the
 * caution triangle, which belongs to `notice` alone. Composes muted-foreground
 * and the caption type role; zero new tokens, the count stays 83.
 */

const ICONS = { info: Info, clock: Clock } as const;

export interface NoticeCaptionProps {
  icon?: "info" | "clock";
  children: React.ReactNode;
  className?: string;
}

export function NoticeCaption({ icon = "info", children, className }: NoticeCaptionProps) {
  const Icon = ICONS[icon] ?? Info;
  return (
    <p className={cn("flex items-start gap-1.5", className)}>
      <Icon
        aria-hidden="true"
        className="mt-[2px] h-3 w-3 shrink-0 text-muted-foreground"
      />
      <span className="text-caption text-muted-foreground">{children}</span>
    </p>
  );
}
