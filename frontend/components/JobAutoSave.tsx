"use client";

import { useEffect, useRef, useState } from "react";
import { saveJob } from "@/lib/api";
import { useDashboardStore } from "@/lib/store";

/**
 * Persists one complete job record once the analysis is ready, then flushes any
 * queued corrections. Mounted in the Outputs layout (results section).
 *
 * Hook point: in the current flow there is no single "analysis complete" event —
 * panels compute independently. The load profile is the terminal computed output,
 * so a job is saved once billData + surveyInputs + loadData are all present. The
 * save is idempotent server-side (upsert on job_id), so if the inputs change and a
 * new result lands, it re-saves to enrich the same job rather than duplicating it.
 *
 * Best-effort: a failed save never blocks results; it logs and shows a muted notice.
 */
export default function JobAutoSave() {
  const billData = useDashboardStore((s) => s.billData);
  const surveyInputs = useDashboardStore((s) => s.surveyInputs);
  const loadData = useDashboardStore((s) => s.loadData);
  const intervalData = useDashboardStore((s) => s.intervalData);

  const inFlight = useRef(false);
  const lastSignature = useRef<string>("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!billData || !surveyInputs || !loadData) return;

    // De-dupe: only re-save when the meaningful inputs actually change. The interval
    // refs are included so a smart-meter upload (which may land after the first save)
    // re-fires the save and back-links the interval_data row.
    const signature = JSON.stringify({
      tariff: billData.tariff_rate,
      nmi: billData.nmi,
      survey: surveyInputs,
      load: loadData.annual_kwh,
      tier: loadData.accuracy_tier,
      interval: intervalData
        ? {
            nmi: intervalData.nmi,
            raw: intervalData.raw_file_path,
            series: intervalData.parsed_series_ref,
          }
        : null,
    });
    if (inFlight.current || signature === lastSignature.current) return;

    const store = useDashboardStore.getState();
    const payload = store.assembleJobPayload();
    inFlight.current = true;
    setFailed(false);

    saveJob(payload)
      .then((res) => {
        if (res?.job_id) {
          store.setJobId(res.job_id);
          store.flushPendingCorrections();
        }
        lastSignature.current = signature;
      })
      .catch((err) => {
        // Never block results — just surface a muted notice.
        // eslint-disable-next-line no-console
        console.error("[JobAutoSave] save failed:", err);
        setFailed(true);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [billData, surveyInputs, loadData, intervalData]);

  if (failed) {
    return (
      <p className="mb-4 text-xs text-muted-foreground">
        Couldn&apos;t save this analysis for your records — results are unaffected.
      </p>
    );
  }
  return null;
}
