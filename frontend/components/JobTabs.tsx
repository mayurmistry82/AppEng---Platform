"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";

/**
 * Per-job top tabs (Stage 2.2) — layout from
 * docs/2026-08-04-worksheet-wireframe-v4-compare.html. Rendered ONLY inside
 * /jobs/[id]/* by that segment's layout — never on /jobs, /equipment or /account.
 * Active tab = amber (same sanctioned rule as the rail).
 */

const TABS = [
  { segment: "worksheet", label: "Worksheet" },
  { segment: "results", label: "Results" },
  { segment: "load-insight", label: "Load insight" },
  { segment: "report", label: "Report" },
] as const;

export default function JobTabs() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const id = params.id;

  return (
    <nav className="flex items-end gap-1 border-b border-border bg-card px-4">
      {TABS.map((tab) => {
        const href = `/jobs/${id}/${tab.segment}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={tab.segment}
            href={href}
            className={`-mb-px border-b-2 px-3 py-2.5 text-nav transition ${
              active
                ? "border-brand-amber text-brand-amber"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
