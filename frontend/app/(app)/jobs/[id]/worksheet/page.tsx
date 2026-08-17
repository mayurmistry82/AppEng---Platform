import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { ResultsBar } from "@/components/worksheet/results-bar";
import { WorksheetBody } from "@/components/worksheet/worksheet-body";
import { getJob } from "@/lib/job-server";
import {
  addressRoofView,
  energyDataView,
  phaseStates,
  resultsBarView,
  roofDiagramView,
  sectionStates,
  siteDetailsView,
  worksheetErrorCopy,
} from "@/lib/worksheet";

/**
 * Worksheet (checklist 3.3) — the shell: frozen results bar + phase rail +
 * eleven section shells with derived progressive unlock. Section CONTENT is
 * 3.4-3.15.
 *
 * getJob never throws; every failure renders the panel below. No redirect on
 * 401 — the (app) layout and middleware own auth redirects, and a redirect
 * here would hide a real auth-wiring bug (the 3.1 reasoning). The 404 copy is
 * deliberately its own heading/body: the backend answers identically for
 * missing and foreign jobs, so existence never leaks.
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
    const notFound = result.kind === "http" && result.status === 404;
    return (
      <div className="w-full px-6 py-6">
        <div className="rounded-lg border border-destructive/40 bg-destructive-subtle p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 text-destructive"
            />
            <div>
              <h2 className="text-h3 text-foreground">{copy.heading}</h2>
              <p className="mt-1 text-body text-muted-foreground">{copy.body}</p>
              {notFound ? (
                <Link
                  href="/jobs"
                  className="mt-3 inline-block text-body text-primary hover:underline"
                >
                  ← Back to jobs
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const job = result.data;
  // The section specs carry predicate functions — strip to the serialisable
  // fields before crossing into the client component. `phase` travels with
  // them (3.3a fix 5) so the body can group without importing SECTIONS and
  // pulling all eleven predicate closures into the client bundle.
  const sections = sectionStates(job).map(
    ({ id: sectionId, title, builtAt, phase, state }) => ({
      id: sectionId,
      title,
      builtAt,
      phase,
      state,
    }),
  );

  return (
    <div className="w-full px-6 pb-8">
      <ResultsBar view={resultsBarView(job)} />
      <WorksheetBody
        sections={sections}
        phases={phaseStates(job)}
        addressRoof={addressRoofView(job)}
        siteDetails={siteDetailsView(job)}
        roofDiagram={roofDiagramView(job)}
        energyData={energyDataView(job)}
        jobId={id}
      />
    </div>
  );
}
