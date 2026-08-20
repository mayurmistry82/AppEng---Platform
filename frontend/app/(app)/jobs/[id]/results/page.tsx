import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { ResultsTab } from "@/components/results/results-tab";
import { getJob } from "@/lib/job-server";
import { resultsTabView, worksheetErrorCopy } from "@/lib/worksheet";

/**
 * Results tab route (checklist 3.13 prompt 4) — the same getJob + view
 * pattern the worksheet page uses: one fetch, one pure view, no client
 * state. Failure copy is shared with the worksheet (worksheetErrorCopy);
 * the 404 branch stays its own heading because missing and foreign jobs
 * answer identically and existence never leaks.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getJob(id);

  if (!result.ok) {
    const copy = worksheetErrorCopy(result.kind, result.status, `/api/job/${id}`);
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="rounded-lg border border-destructive/40 bg-destructive-subtle p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 text-destructive"
            />
            <div>
              <h2 className="text-h3 text-foreground">{copy.heading}</h2>
              <p className="mt-1 text-body text-muted-foreground">{copy.body}</p>
              <Link href="/jobs" className="text-primary underline">
                Back to jobs
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <h1 className="text-h1 text-foreground">Results</h1>
      <div className="mt-4">
        <ResultsTab view={resultsTabView(result.data)} jobId={id} />
      </div>
    </div>
  );
}
