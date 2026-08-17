"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { NoticeCaption } from "@/components/ui/notice-caption";
import { HoverHelp } from "@/components/ui/tooltip";
import { postFormData } from "@/lib/client-api";
import { clientActionErrorCopy } from "@/lib/jobs";
import {
  intervalUploadView,
  type EnergyDataView,
  type IntervalUploadView,
  type RoofNoticeView,
} from "@/lib/worksheet";
import type { ApiErrorKind } from "@/lib/jobs";

/**
 * Energy data (checklist 3.6 prompt 2) — the smart-meter interval branch.
 *
 * Three body states: nothing supplied yet (the drop zone plus the two
 * greyed-but-VISIBLE future routes — D4: hide controls, never information),
 * a successful upload (the one-line quality readout + classified notices),
 * and a failed parse (the backend's own error, verbatim, with the fallback
 * routes named as coming next).
 *
 * All classification lives in lib/worksheet.ts (D25): this component only
 * renders what intervalUploadView / energyDataView already decided, findings
 * always above captions.
 */

const ACCEPT = ".csv,.dat,.txt";

/**
 * The shared copy helper, with the two section-specific overrides the fallback
 * contract requires: a 404 says the JOB could not be found (never "not yours" —
 * the backend answers identically for absent and foreign), and a 503 says try
 * again in a moment (never "not found").
 */
function uploadErrorCopy(kind: ApiErrorKind, status: number) {
  if (kind === "http" && status === 404) {
    return {
      heading: "This job could not be found",
      body: "The upload was not accepted because the job it belongs to could not be found. Head back to the job list and reopen it.",
    };
  }
  if (kind === "http" && status === 503) {
    return {
      heading: "The server is briefly unavailable",
      body: "Nothing was saved. Try again in a moment.",
    };
  }
  return clientActionErrorCopy(kind, status);
}

/** Findings first, then the quiet captions — D25's ordering, in every section. */
function NoticeStack({ items }: { items: readonly RoofNoticeView[] }) {
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

export function EnergyDataSection({
  view,
  jobId,
}: {
  view: EnergyDataView;
  jobId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [upload, setUpload] = React.useState<IntervalUploadView | null>(null);
  const [replacing, setReplacing] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string } | null
  >(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function send(file: File) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("job_id", jobId);
      const result = await postFormData<Record<string, unknown>>(
        "/api/interval/upload",
        form,
      );
      if (!result.ok) {
        setActionError(uploadErrorCopy(result.kind, result.status));
        return;
      }
      setUpload(intervalUploadView(result.data));
      setReplacing(false);
      // The DATABASE decides completeness — refresh so the server re-reads the
      // rows the backend just wrote and the section can tick.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function pickFile(files: FileList | null) {
    const file = files?.[0];
    if (file) void send(file);
  }

  const haveFreshUpload = upload !== null && upload.ok;
  const haveStored = view.state === "have_interval";
  const showReadState = (haveFreshUpload || haveStored) && !replacing;
  const failed = upload !== null && !upload.ok;

  const dropZone = (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        pickFile(e.dataTransfer?.files ?? null);
      }}
      className={`flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center ${
        dragOver ? "border-primary bg-accent" : "border-border-strong bg-bg-subtle"
      }`}
    >
      <p className="text-body text-foreground">
        {busy ? "Reading the file…" : "Drop a NEM12 or interval CSV here"}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-caption text-muted-foreground">or</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          Choose a file
        </Button>
        <span className="text-caption text-muted-foreground">.csv · .dat · .txt</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        aria-label="Choose an interval data file"
        onChange={(e) => {
          pickFile(e.target.files);
          e.target.value = ""; // same file re-selectable — a Replace re-upload is normal
        }}
      />
    </div>
  );

  // The stored-state summary line when there is no fresh response to show.
  const storedParts = [
    view.nmi ? `Meter ${view.nmi}` : null,
    view.coverageDays !== null ? `${view.coverageDays} days` : null,
    view.periodStart && view.periodEnd
      ? `${view.periodStart.slice(0, 10)} to ${view.periodEnd.slice(0, 10)}`
      : null,
    // Never inferred from the file's presence: load_profiles or nothing.
    view.tier !== null ? `Tier ${view.tier}` : "Tier not recorded",
  ].filter((p): p is string => p !== null);

  return (
    <div className="flex flex-col gap-3">
      {actionError ? (
        <Notice tone="problem" title={actionError.heading}>
          {actionError.body}
        </Notice>
      ) : null}

      {showReadState ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-label text-foreground">
              Smart-meter data — read and checked
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReplacing(true)}
              disabled={busy}
            >
              Replace file
            </Button>
          </div>
          <p className="metric-sm text-foreground">
            {(haveFreshUpload && upload.readoutParts.length > 0
              ? upload.readoutParts
              : storedParts
            ).join(" · ")}
          </p>
          <NoticeStack
            items={[...(haveFreshUpload ? upload.notices : []), ...view.notices]}
          />
        </>
      ) : (
        <>
          {failed ? (
            <>
              <Notice tone="problem" title="This file couldn't be read">
                {upload.error}
              </Notice>
              <p className="text-caption text-muted-foreground">
                A recent electricity bill or a short load survey will do the job
                instead — both are built next (3.6/3).
              </p>
            </>
          ) : null}

          {!failed && !replacing ? (
            <p className="text-body text-foreground">
              How we work out what this home uses. Best first.
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-primary">
                ●
              </span>
              <span className="text-label text-foreground">
                Smart-meter interval data
              </span>
              <span className="rounded border border-primary px-1.5 py-0.5 text-overline text-primary">
                Recommended
              </span>
              <HoverHelp label="What is NEM12?">
                NEM12 is the standard file your electricity distributor records
                smart-meter readings in — half-hourly usage, usually as a .csv.
                The customer can download it from their retailer or distributor
                portal (often under &quot;My usage data&quot;), or you can
                request it on their behalf with their consent.
              </HoverHelp>
            </div>
            <p className="pl-6 text-caption text-muted-foreground">
              Half-hourly readings from the meter — the most accurate input
              there is, and the only one that unlocks precise battery sizing.
            </p>
            <div className="pl-6">{dropZone}</div>
          </div>

          {/* Visible but disabled — greyed, never hidden (D4, and 3.2's rule
              for Paths C and D). Not buttons; nothing happens on click. */}
          <div className="flex items-center justify-between gap-2 pl-0.5">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-text-disabled">
                ○
              </span>
              <span className="text-label text-text-disabled">
                A recent electricity bill
              </span>
            </div>
            <span className="text-caption text-text-disabled">
              Built next — 3.6/3
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 pl-0.5">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-text-disabled">
                ○
              </span>
              <span className="text-label text-text-disabled">
                A short load survey
              </span>
            </div>
            <span className="text-caption text-text-disabled">
              Built next — 3.6/3
            </span>
          </div>
        </>
      )}
    </div>
  );
}
