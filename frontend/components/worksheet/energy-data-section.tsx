"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { NoticeCaption } from "@/components/ui/notice-caption";
import { HoverHelp } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KpiTile } from "@/components/ui/kpi-tile";
import { LoadPreviewStrip } from "@/components/worksheet/load-preview-strip";
import { postFormData, postJson } from "@/lib/client-api";
import { clientActionErrorCopy } from "@/lib/jobs";
import {
  EMPTY_SURVEY_ANSWERS,
  SURVEY_OPTIONS,
  billAddressCheck,
  billAddressNotice,
  billParseView,
  demandStatusLine,
  formatAnnualKwh,
  formatDailyKwh,
  peakHeadline,
  intervalUploadView,
  loadPreviewView,
  surveyComplete,
  tierFor,
  tierMismatchNotice,
  typedUsageError,
  usagePlausibilityNotice,
  type BillParseView,
  type DemandInputs,
  type EnergyDataView,
  type IntervalUploadView,
  type LoadPreviewView,
  type RoofNoticeView,
  type SurveyAnswers,
} from "@/lib/worksheet";
import type { ApiErrorKind } from "@/lib/jobs";

/**
 * Energy data (checklist 3.6; tier model corrected under D26).
 *
 * Route 1 — the smart-meter interval file — is unchanged: a measured total AND
 * a measured shape, Tier 3.
 *
 * Below it, the bill and the survey are NOT two rungs on a ladder — they are
 * the two halves of one: the yearly total (from a bill, or typed by the
 * installer and labelled as such) and the five questions that give it a
 * shape. Total alone → Tier 1 (flat profile). Total + all five → Tier 2.
 * Neither → NO tier at all: the engine answers 422 and this screen says so
 * plainly, because a tier shown for a job with no profile is the exact lie
 * D26 exists to stop.
 *
 * The live status line derives from the SAME predicate the engine uses
 * (tierFor mirrors routes/load.py's branch order), never from which control
 * was clicked — and the tier shown after recording is always the backend's
 * `accuracy_tier_written`, with a loud notice if prediction and record ever
 * disagree.
 */

/** A positive finite number off a response, else null — never a zero stand-in. */
function readNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

const INTERVAL_ACCEPT = ".csv,.dat,.txt";
const BILL_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp";

function uploadErrorCopy(kind: ApiErrorKind, status: number, message: string) {
  if (kind === "http" && status === 404) {
    return {
      heading: "This job could not be found",
      body: "The request was not accepted because the job it belongs to could not be found. Head back to the job list and reopen it.",
    };
  }
  if (kind === "http" && status === 503) {
    return {
      heading: "The server is briefly unavailable",
      body: "Nothing was saved. Try again in a moment.",
    };
  }
  if (kind === "http" && status === 422) {
    // We asked for a profile the engine refuses — a real error the UI should
    // have prevented, never rendered as Tier 1. Show the engine's own words.
    return { heading: "The engine needs more than this", body: message };
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

/**
 * The three headline figures (3.6b): how much this house uses, which is what
 * every downstream calculation depends on and appeared nowhere on screen.
 * KpiTile fits exactly; KpiStrip does NOT — it is a hardcoded 4-column grid and
 * these are three figures, so the layout is local rather than forcing it.
 * A figure that cannot be derived is OMITTED, never rendered as zero.
 */
function HeadlineFigures({
  annualKwh,
  dailyAvgKwh,
  preview,
}: {
  annualKwh: number | null;
  dailyAvgKwh: number | null;
  preview: LoadPreviewView;
}) {
  const annual = formatAnnualKwh(annualKwh);
  const daily = formatDailyKwh(dailyAvgKwh);
  const peakLabel = peakHeadline(preview.peak);
  if (annual === null && daily === null && peakLabel === null) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {annual !== null ? <KpiTile label="A year" value={annual} /> : null}
      {daily !== null ? <KpiTile label="A day" value={daily} /> : null}
      {peakLabel !== null && preview.peak !== null ? (
        <KpiTile label={peakLabel} value={preview.peak.label} />
      ) : null}
    </div>
  );
}

interface DemandRecorded {
  /** The BACKEND's accuracy_tier_written — never what the UI predicted. */
  tier: number | null;
  annualKwh: number | null;
  dailyAvgKwh: number | null;
  /** What tierFor predicted at the moment of the call — for the mismatch notice. */
  predicted: number | null;
  preview: LoadPreviewView;
  warnings: string[];
  surveySaved: boolean | null;
  loadProfileSaved: boolean | null;
  usageSource: "interval" | "bill" | "typed" | null;
  surveyIncluded: boolean;
  corrected: boolean;
}

export function EnergyDataSection({
  view,
  jobId,
}: {
  view: EnergyDataView;
  jobId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<"interval" | "bill" | "demand" | null>(null);
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string } | null
  >(null);
  const [dragOver, setDragOver] = React.useState(false);
  const intervalInputRef = React.useRef<HTMLInputElement>(null);
  const billInputRef = React.useRef<HTMLInputElement>(null);

  // Route 1 — interval
  const [upload, setUpload] = React.useState<IntervalUploadView | null>(null);
  const [replacing, setReplacing] = React.useState(false);

  // Half 1 — the yearly total
  const [bill, setBill] = React.useState<BillParseView | null>(null);
  const [billCorrecting, setBillCorrecting] = React.useState(false);
  const [corr, setCorr] = React.useState({ totalKwh: "", periodDays: "", dailyAvgKwh: "" });
  const [showBillZone, setShowBillZone] = React.useState(false);
  const [typedUsage, setTypedUsage] = React.useState("");

  // Half 2 — the five questions
  const [answers, setAnswers] = React.useState<SurveyAnswers>(view.survey);

  const [recorded, setRecorded] = React.useState<DemandRecorded | null>(null);

  // ── Interval upload (route 1, unchanged) ───────────────────────────────────
  async function sendInterval(file: File) {
    if (busy) return;
    setBusy("interval");
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
        setActionError(uploadErrorCopy(result.kind, result.status, result.message));
        return;
      }
      const parsed = intervalUploadView(result.data);
      setUpload(parsed);
      setReplacing(false);
      if (parsed.ok) {
        const data = result.data as Record<string, unknown>;
        setRecorded({
          tier: parsed.tier,
          annualKwh: readNum((data.load as Record<string, unknown> | undefined)?.annual_kwh),
          dailyAvgKwh: readNum((data.load as Record<string, unknown> | undefined)?.daily_avg_kwh),
          predicted: tierFor({
            hasIntervalProfile: true,
            usageKwh: null,
            usageSource: "interval",
            surveyComplete: false,
          }),
          preview: loadPreviewView(
            data.load,
            (data.load as Record<string, unknown> | undefined)?.daily_avg_kwh,
            parsed.tier,
          ),
          warnings: [],
          surveySaved: null,
          loadProfileSaved: parsed.loadProfileSaved,
          usageSource: "interval",
          surveyIncluded: false,
          corrected: false,
        });
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  // ── Bill upload (half 1) ───────────────────────────────────────────────────
  async function sendBill(file: File) {
    if (busy) return;
    setBusy("bill");
    setActionError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await postFormData<Record<string, unknown>>(
        `/api/job/${jobId}/bill`,
        form,
      );
      if (!result.ok) {
        setActionError(uploadErrorCopy(result.kind, result.status, result.message));
        return;
      }
      const parsed = billParseView(result.data);
      setBill(parsed);
      setBillCorrecting(false);
      setCorr(parsed.correction);
      router.refresh(); // the bills row is persisted server-side
    } finally {
      setBusy(null);
    }
  }

  function corrEdited() {
    if (!bill) return { totalKwh: false, periodDays: false, dailyAvgKwh: false };
    return {
      totalKwh: corr.totalKwh !== bill.correction.totalKwh,
      periodDays: corr.periodDays !== bill.correction.periodDays,
      dailyAvgKwh: corr.dailyAvgKwh !== bill.correction.dailyAvgKwh,
    };
  }

  /** The bill's daily figure — corrected where edited, parsed otherwise. */
  function billDaily(): number | null {
    const daily = Number(corr.dailyAvgKwh);
    if (corr.dailyAvgKwh.trim() !== "" && Number.isFinite(daily) && daily > 0) {
      return daily;
    }
    const total = Number(corr.totalKwh);
    const days = Number(corr.periodDays);
    if (
      corr.totalKwh.trim() !== "" && corr.periodDays.trim() !== "" &&
      Number.isFinite(total) && total > 0 && Number.isFinite(days) && days > 0
    ) {
      return total / days;
    }
    return bill?.dailyAvgKwh ?? null;
  }

  // ── The usage figure — one resolution, used by the line AND the call ───────
  const typedTrimmed = typedUsage.trim();
  const typedNumber = typedTrimmed === "" ? null : Number(typedTrimmed);
  const typedError =
    typedNumber !== null ? typedUsageError(typedNumber) : null;
  const typedValid = typedNumber !== null && typedError === null;
  const billDailyNow = bill?.ok ? billDaily() : null;
  // A figure the installer typed OVERRIDES the parsed bill — a human's number
  // beats our reading of a photo, and the override is labelled on screen.
  const usageKwh: number | null = typedValid
    ? typedNumber
    : billDailyNow !== null
      ? Math.round(billDailyNow * 365)
      : null;
  const usageSource: DemandInputs["usageSource"] =
    typedValid ? "typed" : billDailyNow !== null ? "bill" : null;

  const inputs: DemandInputs = {
    hasIntervalProfile: false, // this half only renders when route 1 has nothing
    usageKwh,
    usageSource,
    surveyComplete: surveyComplete(answers),
  };
  const status = demandStatusLine(inputs);

  // ── Record the profile ─────────────────────────────────────────────────────
  async function recordProfile() {
    if (busy || usageKwh === null) return;
    setBusy("demand");
    setActionError(null);
    try {
      const predicted = tierFor(inputs);
      const body: Record<string, unknown> = {
        tariff_type: answers.tariffType ?? bill?.tariffType ?? null,
      };
      if (usageSource === "typed") {
        body.annual_kwh = usageKwh;
      } else {
        body.daily_avg_kwh = billDailyNow;
      }
      const anyAnswer =
        answers.householdSize !== null ||
        answers.occupancy !== null ||
        answers.hotWater !== null ||
        answers.appliances !== null;
      if (anyAnswer) {
        body.household_size = answers.householdSize;
        body.occupancy = answers.occupancy;
        body.hot_water = answers.hotWater;
        if (answers.appliances !== null) body.appliances = answers.appliances;
      }
      const result = await postJson<Record<string, unknown>>(
        `/api/job/${jobId}/demand`,
        body,
      );
      if (!result.ok) {
        setActionError(uploadErrorCopy(result.kind, result.status, result.message));
        return;
      }
      const data = result.data;
      const tierRaw = data.accuracy_tier_written;
      const warnings = Array.isArray(data.warnings)
        ? data.warnings.filter((w): w is string => typeof w === "string")
        : [];
      const edited = corrEdited();
      setRecorded({
        tier:
          typeof tierRaw === "number" && Number.isInteger(tierRaw) ? tierRaw : null,
        annualKwh: readNum(data.annual_kwh),
        dailyAvgKwh: readNum(data.daily_avg_kwh),
        predicted,
        preview: loadPreviewView(
          data,
          data.daily_avg_kwh,
          typeof tierRaw === "number" ? tierRaw : null,
        ),
        warnings,
        surveySaved: typeof data.survey_saved === "boolean" ? data.survey_saved : null,
        loadProfileSaved:
          typeof data.load_profile_saved === "boolean" ? data.load_profile_saved : null,
        usageSource,
        surveyIncluded: anyAnswer,
        corrected: edited.totalKwh || edited.periodDays || edited.dailyAvgKwh,
      });
      router.refresh(); // completeness reads the DATABASE
    } finally {
      setBusy(null);
    }
  }

  function pick(handler: (f: File) => void) {
    return (files: FileList | null) => {
      const file = files?.[0];
      if (file) handler(file);
    };
  }

  function dropZone(
    accept: string,
    label: string,
    types: string,
    inputRef: React.RefObject<HTMLInputElement>,
    onFile: (f: File) => void,
  ) {
    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          pick(onFile)(e.dataTransfer?.files ?? null);
        }}
        className={`flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center ${
          dragOver ? "border-primary bg-accent" : "border-border-strong bg-bg-subtle"
        }`}
      >
        <p className="text-body text-foreground">
          {busy !== null ? "Reading the file…" : label}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-caption text-muted-foreground">or</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
          >
            Choose a file
          </Button>
          <span className="text-caption text-muted-foreground">{types}</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          aria-label={label}
          onChange={(e) => {
            pick(onFile)(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    );
  }

  // ── Derived render state ───────────────────────────────────────────────────
  const haveFreshInterval = upload !== null && upload.ok;
  const haveStoredInterval = view.state === "have_interval";
  const intervalFailed = upload !== null && !upload.ok;
  const showIntervalRead = (haveFreshInterval || haveStoredInterval) && !replacing;

  const billNotices: RoofNoticeView[] = bill?.ok
    ? [
        ...bill.notices,
        ...(bill.persisted === false
          ? [
              {
                tone: "caution",
                level: "notice",
                title: "The parsed bill could not be saved to this job",
                body: bill.warning ?? "Try uploading it again in a moment.",
              } satisfies RoofNoticeView,
            ]
          : []),
        ...((): RoofNoticeView[] => {
          const notice = billAddressNotice(
            billAddressCheck(bill.billAddress, view.address),
          );
          return notice ? [notice] : [];
        })(),
      ]
    : [];

  const plausibility =
    usageSource === "typed" && usageKwh !== null
      ? usagePlausibilityNotice(usageKwh)
      : null;

  // The quality figures come from view.readoutParts — the SAME
  // intervalReadoutParts the fresh upload uses, so a reload cannot show a
  // different readout for the same file. "Tier n" is inside those parts when
  // known; only the not-recorded fallback is added here.
  const storedParts = [
    view.nmi ? `Meter ${view.nmi}` : null,
    view.periodStart && view.periodEnd
      ? `${view.periodStart.slice(0, 10)} to ${view.periodEnd.slice(0, 10)}`
      : null,
    ...view.readoutParts,
    ...(view.tier === null ? ["Tier not recorded"] : []),
  ].filter((p): p is string => p !== null);

  const storedPreview = loadPreviewView(
    view.profileWeights,
    view.dailyAvgKwh,
    view.tier,
  );
  const edited = corrEdited();
  const mismatch = recorded
    ? tierMismatchNotice(recorded.predicted, recorded.tier)
    : null;

  return (
    <div className="flex flex-col gap-3">
      {actionError ? (
        <Notice tone="problem" title={actionError.heading}>
          {actionError.body}
        </Notice>
      ) : null}

      {/* ── The recorded profile — the BACKEND's tier, never the UI's hope ── */}
      {recorded ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <p className="text-label text-foreground">
            Usage profile recorded —{" "}
            {recorded.tier !== null ? `Tier ${recorded.tier}` : "tier not recorded"}
          </p>
          {mismatch ? (
            <Notice tone={mismatch.tone} title={mismatch.title}>
              {mismatch.body}
            </Notice>
          ) : null}
          <HeadlineFigures
            annualKwh={recorded.annualKwh}
            dailyAvgKwh={recorded.dailyAvgKwh}
            preview={recorded.preview}
          />
          {recorded.preview.ok ? <LoadPreviewStrip view={recorded.preview} /> : null}
          {recorded.warnings.map((w, i) => (
            <Notice key={`w-${i}`} tone="caution" title="Not fully saved">
              {w}
            </Notice>
          ))}
          {recorded.surveyIncluded && recorded.surveySaved === false ? (
            <Notice tone="caution" title="The survey answers did not save">
              The profile may be recorded without them — record it again.
            </Notice>
          ) : null}
          {recorded.usageSource === "bill" ? (
            <NoticeCaption>
              A bill gives us twelve months of totals, not the shape of your day.
            </NoticeCaption>
          ) : null}
          {recorded.usageSource === "typed" ? (
            <NoticeCaption>
              The yearly total was entered by the installer — a real number from
              a person, not a measurement.
            </NoticeCaption>
          ) : null}
          {recorded.tier === 1 ? (
            <NoticeCaption>
              A yearly total on its own has no daily shape.
            </NoticeCaption>
          ) : null}
          {recorded.corrected ? (
            <NoticeCaption>
              Figures you corrected are used instead of the parsed ones.
            </NoticeCaption>
          ) : null}
        </div>
      ) : null}

      {/* ── Route 1: the smart-meter interval file ── */}
      {showIntervalRead && !recorded ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-label text-foreground">
              Smart-meter data — read and checked
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReplacing(true)}
              disabled={busy !== null}
            >
              Replace file
            </Button>
          </div>
          <p className="metric-sm text-foreground">
            {(haveFreshInterval && upload.readoutParts.length > 0
              ? upload.readoutParts
              : storedParts
            ).join(" · ")}
          </p>
          <HeadlineFigures
            annualKwh={view.annualKwh}
            dailyAvgKwh={view.dailyAvgKwh}
            preview={storedPreview}
          />
          {storedPreview.ok ? <LoadPreviewStrip view={storedPreview} /> : null}
          <NoticeStack
            items={[...(haveFreshInterval ? upload.notices : []), ...view.notices]}
          />
        </>
      ) : null}

      {(!showIntervalRead || replacing) && !recorded ? (
        <>
          {intervalFailed ? (
            <>
              <Notice tone="problem" title="This file couldn't be read">
                {upload.error}
              </Notice>
              {/* UT-5, reframed under D26: stepping down never deletes anything. */}
              <NoticeCaption>
                The file stays attached to the job. The profile now comes from
                the yearly total below — Tier 1 on its own, Tier 2 with the five
                questions answered.
              </NoticeCaption>
            </>
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
            <div className="pl-6">
              {dropZone(
                INTERVAL_ACCEPT,
                "Drop a NEM12 or interval CSV here",
                ".csv · .dat · .txt",
                intervalInputRef,
                (f) => void sendInterval(f),
              )}
            </div>
          </div>

          {/* ── The two halves of the next rung (D26) ── */}
          <p className="text-body text-foreground">
            No smart-meter file? We need two things: how much this home uses in
            a year, and when it uses it.
          </p>

          {/* Half 1 — how much, per year */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-muted-foreground">
                1
              </span>
              <span className="text-label text-foreground">How much, per year</span>
              <HoverHelp label="Where does the total come from?">
                A bill carries up to twelve months of usage totals and the
                tariff. If you already know the yearly figure, you can type it
                instead — it will be labelled as entered by you.
              </HoverHelp>
            </div>
            {bill === null && !showBillZone ? (
              <div className="flex items-center gap-2 pl-6">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setShowBillZone(true)}
                >
                  Upload a bill
                </Button>
              </div>
            ) : null}
            {showBillZone && (bill === null || !bill.ok) ? (
              <div className="pl-6">
                {dropZone(
                  BILL_ACCEPT,
                  "Drop a bill here — PDF or a photo",
                  ".pdf · .jpg · .png · .webp",
                  billInputRef,
                  (f) => void sendBill(f),
                )}
              </div>
            ) : null}
            {bill !== null && !bill.ok ? (
              <div className="flex flex-col gap-2 pl-6">
                <Notice tone="problem" title="This bill couldn't be read">
                  {bill.error}
                </Notice>
                <NoticeCaption>
                  You can type the yearly total below instead, or try a clearer
                  photo.
                </NoticeCaption>
              </div>
            ) : null}
            {bill?.ok ? (
              <div className="flex flex-col gap-2 pl-6">
                <div className="flex items-center gap-2">
                  <p className="metric-sm text-foreground">
                    Bill read — {bill.readoutParts.join(" · ")}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => billInputRef.current?.click()}
                    disabled={busy !== null}
                  >
                    Replace the bill
                  </Button>
                  {!billCorrecting ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setBillCorrecting(true)}
                      disabled={busy !== null}
                    >
                      Correct them
                    </Button>
                  ) : null}
                  <input
                    ref={billInputRef}
                    type="file"
                    accept={BILL_ACCEPT}
                    className="hidden"
                    aria-label="Replace the bill file"
                    onChange={(e) => {
                      pick((f) => void sendBill(f))(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>
                <NoticeStack items={billNotices} />
                {billCorrecting ? (
                  <div className="flex flex-wrap items-end gap-2">
                    {(
                      [
                        ["totalKwh", "Total kWh"],
                        ["periodDays", "Days"],
                        ["dailyAvgKwh", "Daily average kWh"],
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key}>
                        <label
                          className="text-caption text-muted-foreground"
                          htmlFor={`bill-${key}`}
                        >
                          {label}
                        </label>
                        <Input
                          id={`bill-${key}`}
                          className="mt-1 w-[130px]"
                          type="number"
                          inputMode="decimal"
                          value={corr[key]}
                          onChange={(e) =>
                            setCorr((c) => ({ ...c, [key]: e.target.value }))
                          }
                        />
                        {edited[key] ? (
                          <p className="mt-0.5 text-caption text-muted-foreground">
                            entered by the installer
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-2 pl-6">
              <div>
                <label className="text-caption text-muted-foreground" htmlFor="typed-annual">
                  or — Annual usage (kWh)
                </label>
                <Input
                  id="typed-annual"
                  className="mt-1 w-[140px]"
                  type="number"
                  inputMode="decimal"
                  placeholder="e.g. 8240"
                  value={typedUsage}
                  onChange={(e) => setTypedUsage(e.target.value)}
                />
              </div>
              <p className="pb-1 text-caption text-muted-foreground">
                you can type it if you know it
              </p>
            </div>
            {typedTrimmed !== "" && typedError !== null ? (
              <p className="pl-6 text-caption text-destructive">{typedError}</p>
            ) : null}
            {usageSource === "typed" ? (
              <div className="pl-6">
                <NoticeCaption>
                  Figures you typed are used instead of the parsed ones — this
                  total is entered by the installer.
                </NoticeCaption>
              </div>
            ) : null}
            {plausibility ? (
              <div className="pl-6">
                <Notice tone={plausibility.tone} title={plausibility.title}>
                  {plausibility.body}
                </Notice>
              </div>
            ) : null}
          </div>

          {/* Half 2 — when it uses it */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-muted-foreground">
                2
              </span>
              <span className="text-label text-foreground">
                When it uses it — five questions
              </span>
              <span className="text-caption text-muted-foreground">optional</span>
              <HoverHelp label="What do the questions do?">
                They pick a national usage archetype for a home like this one,
                which gives the yearly total a daily shape. Without them the
                profile is flat.
              </HoverHelp>
            </div>
            <div className="flex flex-wrap gap-3 pl-6">
              {(
                [
                  ["householdSize", "How many people live here?", SURVEY_OPTIONS.householdSize],
                  ["occupancy", "Home during the day?", SURVEY_OPTIONS.occupancy],
                  ["hotWater", "Hot water", SURVEY_OPTIONS.hotWater],
                  ["tariffType", "Current tariff", SURVEY_OPTIONS.tariffType],
                ] as const
              ).map(([key, label, options]) => (
                <div key={key}>
                  <label className="text-caption text-muted-foreground" htmlFor={`survey-${key}`}>
                    {label}
                  </label>
                  <div className="mt-1 w-[180px]">
                    <Select
                      value={answers[key] ?? ""}
                      onValueChange={(value) =>
                        setAnswers((a) => ({ ...a, [key]: value }))
                      }
                    >
                      <SelectTrigger id={`survey-${key}`} aria-label={label}>
                        <SelectValue placeholder="Choose…" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {SURVEY_LABELS[option] ?? option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
            <div className="pl-6">
              <p className="text-caption text-muted-foreground">Any of these?</p>
              <div className="mt-1 flex items-center gap-2">
                {SURVEY_OPTIONS.appliances.map((appliance) => {
                  const on = answers.appliances?.includes(appliance) ?? false;
                  return (
                    <Button
                      key={appliance}
                      variant={on ? "primary" : "secondary"}
                      size="sm"
                      aria-pressed={on}
                      onClick={() =>
                        setAnswers((a) => {
                          const current = a.appliances ?? [];
                          return {
                            ...a,
                            appliances: on
                              ? current.filter((x) => x !== appliance)
                              : [...current, appliance],
                          };
                        })
                      }
                    >
                      {SURVEY_LABELS[appliance] ?? appliance}
                    </Button>
                  );
                })}
                {/* load.py tests `appliances is not None`: an EMPTY list is a
                    real answer, an untouched control is not — so "none of
                    these" needs its own way to say so. */}
                <Button
                  variant={
                    answers.appliances !== null && answers.appliances.length === 0
                      ? "primary"
                      : "secondary"
                  }
                  size="sm"
                  aria-pressed={
                    answers.appliances !== null && answers.appliances.length === 0
                  }
                  onClick={() => setAnswers((a) => ({ ...a, appliances: [] }))}
                >
                  None of these
                </Button>
              </div>
            </div>
          </div>

          {/* ── Where this leaves the job — the live line ── */}
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-subtle p-3">
            <p className="text-overline text-muted-foreground">
              Where this leaves the job
            </p>
            <p className="text-body text-foreground">
              {status.have}
              {status.tier !== null ? (
                <span className="metric-sm"> — Tier {status.tier}</span>
              ) : null}
            </p>
            {status.next ? (
              <p className="text-caption text-muted-foreground">{status.next}</p>
            ) : null}
            <div className="mt-1">
              <Button
                size="sm"
                onClick={() => void recordProfile()}
                disabled={busy !== null || usageKwh === null}
              >
                {busy === "demand" ? "Recording…" : "Record this profile"}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Human labels for the backend's option VALUES — display only; the values
 *  sent are always the exact strings routes/load.py accepts. */
const SURVEY_LABELS: Record<string, string> = {
  "1": "1 person",
  "2": "2 people",
  "3-4": "3–4 people",
  "5+": "5 or more",
  always_home: "Always home",
  away_weekdays: "Away weekdays",
  shift_work: "Shift work / irregular",
  electric_storage: "Electric storage",
  heat_pump: "Heat pump",
  gas: "Gas",
  solar_hws: "Solar hot water",
  ev: "EV",
  pool_pump: "Pool pump",
  ducted_ac: "Ducted A/C",
  single_rate: "Single rate",
  tou: "Time of use",
  demand: "Demand",
  not_sure: "Not sure",
};
