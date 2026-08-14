import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Notice — DESIGN.md `components: notice` (added 2026-08-14 for 3.4-B).
 *
 * The small tinted panel that EXPLAINS something to the installer. Specced
 * before its first use because 3.6, 3.12 and 3.15 need the same object — four
 * hand-rolled versions is a drift factory.
 *
 * role="note", NOT role="alert" — rendered with the page, never announced on
 * arrival. Every tone carries its own icon AND its own wording so the meaning
 * survives greyscale (never colour-only). CAUTION IS ORANGE (`warning`), never
 * `brand-amber` — amber's four sanctioned uses do not include notices.
 * An unrecognised tone falls back to info rather than throwing (status-pill's
 * rule). Composes existing tokens only; the token count stays at 83.
 */

export type NoticeTone = "info" | "success" | "caution" | "problem";

const TONE_STYLES: Record<
  NoticeTone,
  { container: string; icon: string; Icon: typeof Info }
> = {
  info: {
    container: "border-info bg-info-subtle",
    icon: "text-info",
    Icon: Info,
  },
  success: {
    container: "border-success bg-success-subtle",
    icon: "text-success",
    Icon: CheckCircle2,
  },
  caution: {
    container: "border-warning bg-warning-subtle",
    icon: "text-warning",
    Icon: AlertTriangle,
  },
  problem: {
    container: "border-destructive bg-destructive-subtle",
    icon: "text-destructive",
    Icon: AlertCircle,
  },
};

function isNoticeTone(value: string): value is NoticeTone {
  return Object.prototype.hasOwnProperty.call(TONE_STYLES, value);
}

export interface NoticeProps {
  tone: NoticeTone | (string & {});
  title: string;
  children?: React.ReactNode;
  /** 0-2 secondary/ghost buttons — a notice never carries a section's primary action. */
  actions?: React.ReactNode;
  className?: string;
}

export function Notice({ tone, title, children, actions, className }: NoticeProps) {
  const resolved: NoticeTone =
    typeof tone === "string" && isNoticeTone(tone) ? tone : "info";
  const styles = TONE_STYLES[resolved];
  const Icon = styles.Icon;
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5",
        styles.container,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-[1px] h-4 w-4 shrink-0", styles.icon)} />
      <div className="min-w-0">
        <p className="text-label font-semibold text-foreground">{title}</p>
        {children ? (
          <div className="mt-0.5 text-caption text-muted-foreground">{children}</div>
        ) : null}
        {actions ? <div className="mt-2 flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
