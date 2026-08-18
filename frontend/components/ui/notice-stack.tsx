import { Notice } from "@/components/ui/notice";
import { NoticeCaption } from "@/components/ui/notice-caption";
import type { RoofNoticeView } from "@/lib/worksheet";

/**
 * Lifted verbatim out of energy-data-section.tsx at 3.8 — the body below is
 * that function unchanged, character for character, because two copies of
 * D25's ordering rule is exactly the drift this project keeps paying for
 * (F100). One definition, every section imports it.
 */

/** Findings first, then the quiet captions — D25's ordering, in every section. */
export function NoticeStack({ items }: { items: readonly RoofNoticeView[] }) {
  const findings = items.filter((n) => n.level === "notice");
  const captions = items.filter((n) => n.level === "caption");
  return (
    <>
      {findings.map((n, i) => (
        <Notice key={`n-${i}`} tone={n.tone} title={n.title}>
          {n.body}
        </Notice>
      ))}
      {captions.map((n, i) => (
        <NoticeCaption key={`c-${i}`} icon={n.icon ?? "info"}>
          {n.body}
        </NoticeCaption>
      ))}
    </>
  );
}
