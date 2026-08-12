import JobTabs from "@/components/JobTabs";

/**
 * Per-job wrapper: renders the four tabs above every /jobs/[id]/* page.
 *
 * SCOPE (2.2): tabs only. The job bar that sits ABOVE these tabs — address,
 * status pill, job type, Residential|C&I toggle, accuracy meter, Save, Report —
 * is checklist 3.3, as is the frozen results bar. Do not add them here.
 *
 * The [id] segment is used for routing only; no job is fetched. An unknown id
 * still renders the shell + tabs — real job validation is Stage 3.
 */
export default function JobLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <JobTabs />
      <div className="flex-1">{children}</div>
    </div>
  );
}
