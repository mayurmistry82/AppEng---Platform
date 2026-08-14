import JobTabs from "@/components/JobTabs";
import { JobBar } from "@/components/worksheet/job-bar";
import { getJob } from "@/lib/job-server";
import { jobBarView } from "@/lib/worksheet";

/**
 * Per-job wrapper (3.3): job bar ABOVE the four tabs, on every /jobs/[id]/*
 * page.
 *
 * getJob is React-cache()d, so this call and the page's call resolve from ONE
 * `GET /api/job/{id}` per request — do not "optimise" either call away.
 *
 * On any fetch failure the bar is simply omitted: the page owns the error
 * panel (worksheetErrorCopy) and rendering a second, bar-shaped error here
 * would duplicate it. Tabs still render so navigation survives.
 *
 * FROZEN HEADER (3.3a fix 4) — the wireframe puts `.topbar` and `.tabs` inside
 * `.main` but OUTSIDE `.scrollwrap`, and only `.scrollwrap` carries
 * overflow:auto. So this layout is a full-height, NON-scrolling flex column:
 * the bar and tabs are fixed rows, and everything else lives in the one
 * scrolling region below them. The results bar then sticks to the top of THAT
 * region and lands directly beneath the tabs.
 *
 * Deliberately NOT done with a sticky pixel offset: the job bar wraps to a
 * second line on a narrow window, so any hardcoded offset would drift and the
 * results bar would overlap it.
 *
 * `h-full` (not `min-h-full`) is what keeps the count at ONE scrollbar: the
 * (app) shell's <main> is already `overflow-y-auto`, and a layout that is
 * exactly main's height never overflows it, so main's scrollbar never appears.
 * `min-h-0` on the scrolling child is required for a flex child to be allowed
 * to shrink below its content height.
 */
export default async function JobLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getJob(id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        {result.ok ? <JobBar view={jobBarView(result.data)} /> : null}
        <JobTabs />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
