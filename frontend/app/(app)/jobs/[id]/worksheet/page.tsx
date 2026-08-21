import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { ResultsBar } from "@/components/worksheet/results-bar";
import { WorksheetBody } from "@/components/worksheet/worksheet-body";
import { apiGet } from "@/lib/api-server";
import { getJob } from "@/lib/job-server";
import {
  addressRoofView,
  batterySizingView,
  energyDataView,
  equipmentSpecsView,
  objectiveBudgetView,
  phaseStates,
  resultsBarView,
  resultsView,
  roofDiagramView,
  sectionStates,
  siteDetailsView,
  solarSizingView,
  tariffNetworkView,
  worksheetErrorCopy,
  type EquipmentCatalogue,
  type ExportLimitDefault,
  type FitDefault,
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
  // 3.8 — the two nem lookups that prefill the tariff section. Both are total
  // and never raise upstream; a failure here yields a NULL default, the input
  // starts empty and the section still renders. It must never block the page.
  const site = job as {
    site_state?: unknown;
    site_postcode?: unknown;
  };
  const siteState = typeof site.site_state === "string" ? site.site_state : "";
  const sitePostcode =
    typeof site.site_postcode === "string" ? site.site_postcode : "";
  // 3.10 — the equipment catalogue rides in the SAME Promise.all as the two
  // nem lookups, so it costs no extra round trip of latency. A failure yields
  // null and the view reports catalogueAvailable false; it must NEVER block
  // the page or throw.
  const [exportLimitResult, fitResult, catalogueResult] = await Promise.all([
    siteState
      ? apiGet<ExportLimitDefault>(
          "/api/nem/export-limit",
          new URLSearchParams({ state: siteState, postcode: sitePostcode }),
        )
      : Promise.resolve(null),
    siteState
      ? apiGet<FitDefault>("/api/nem/fit", new URLSearchParams({ state: siteState }))
      : Promise.resolve(null),
    apiGet<EquipmentCatalogue>("/api/equipment"),
  ]);
  const catalogue = catalogueResult.ok ? catalogueResult.data : null;
  const tariffDefaults = {
    exportLimit: exportLimitResult?.ok ? exportLimitResult.data : null,
    fit: fitResult?.ok ? fitResult.data : null,
  };
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
      {/* 3.14 prompt 3: the job id travels so D3's auto-expand can fire ONCE
          for this job — the bar's own preference key holds no job id. */}
      <ResultsBar view={resultsBarView(job)} jobId={id} />
      <WorksheetBody
        sections={sections}
        phases={phaseStates(job)}
        addressRoof={addressRoofView(job)}
        siteDetails={siteDetailsView(job)}
        roofDiagram={roofDiagramView(job)}
        energyData={energyDataView(job)}
        tariffNetwork={tariffNetworkView(job, tariffDefaults)}
        objectiveBudget={objectiveBudgetView(job)}
        equipmentSpecs={equipmentSpecsView(job, catalogue)}
        solarSizing={solarSizingView(job)}
        batterySizing={batterySizingView(job)}
        results={resultsView(job)}
        jobId={id}
      />
    </div>
  );
}
