"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { NoticeCaption } from "@/components/ui/notice-caption";
import { OverrideDrawer } from "@/components/ui/override-drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { postJson } from "@/lib/client-api";
import { clientActionErrorCopy } from "@/lib/jobs";
import {
  EMPTY_PLANE_FORM_ROW,
  MULTI_DWELLING_CAPTION,
  PREFILL_FROM_LOOKUP_CAPTION,
  TILE_H,
  TILE_IMG_SCALE,
  TILE_W,
  planeFormRowsFromView,
  showsGoogleSolarAttribution,
  type AddressRoofView,
  type PlaneFormRow,
  type RoofDiagramReason,
  type RoofDiagramView,
  type RoofNoticeView,
  type SizingInputSave,
} from "@/lib/worksheet";
import type { ApiErrorKind } from "@/lib/jobs";

/**
 * Address & roof (checklist 3.4-B) — the worksheet's first real section body.
 *
 * The DATABASE is the single source of truth: the server page hands in the
 * serialisable view built from the job (getJob, cached, one call per render),
 * and after any successful write this component calls router.refresh() so the
 * server re-reads. The roof model is never mirrored into client state.
 *
 * OI-10: manual/plans entry is a FIRST-CLASS input path with equal weight to
 * the lookup — never labelled a fallback. A failed lookup NEVER blocks manual
 * entry. D4: warnings hide controls, never information — the low-confidence
 * state keeps every plane and the thumbnail visible below its notice.
 *
 * The tile <img> renders only when the section is OPEN and coordinates exist —
 * every render is a billable Maps Static call.
 */

const COMPASS_OPTIONS = [
  { label: "North", value: "0" },
  { label: "North-east", value: "45" },
  { label: "East", value: "90" },
  { label: "South-east", value: "135" },
  { label: "South", value: "180" },
  { label: "South-west", value: "225" },
  { label: "West", value: "270" },
  { label: "North-west", value: "315" },
  { label: "Exact degrees", value: "exact" },
] as const;

/** The manual endpoint accepts at most 12 faces (ManualRoofRequest). */
const MAX_FORM_PLANES = 12;

interface PlaneRowError {
  direction?: string;
  pitch?: string;
  area?: string;
}

function fmt(value: number | null, digits = 1, suffix = ""): string {
  if (value === null) return "—";
  const rounded =
    Math.round(value * 10 ** digits) / 10 ** digits;
  return `${rounded}${suffix}`;
}

function planeAzimuth(row: PlaneFormRow): number | null {
  const raw = row.direction === "exact" ? row.exactDegrees : row.direction;
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Why the panel layout is not drawn (3.5 prompt 2) — every non-drawable state
 * gets a visible, specific line; never a blank box, never a spinner.
 * `dimensions_not_stored` is the normal state for rows looked up before the
 * dimensions were captured; it points at the EXISTING "Look up again" button
 * and never auto-fetches (every lookup is billable).
 */
const DIAGRAM_REASON_COPY: Record<RoofDiagramReason, string> = {
  dimensions_not_stored:
    "The panel size wasn't recorded when this roof was looked up, so the layout can't be drawn to scale. “Look up again” will record it.",
  segment_join_failed:
    "Google's panel layout couldn't be matched to the roof faces, so it isn't drawn.",
  no_panel_positions:
    "Google recorded no panel positions for this roof, so there is no layout to draw.",
  no_coordinates:
    "No coordinates were stored for this roof, so the layout can't be drawn.",
  // Unreachable in practice — roofDiagramView hides the diagram entirely on
  // expiry (the §20.2 notice above the table already explains it) — but the
  // Record must be total and a reachable string beats a runtime hole.
  solar_data_expired:
    "Google's roof data for this job has been deleted, so the layout can't be drawn.",
};

/**
 * Per-face styling, cycled by Google's segment index — FILL-OPACITY ONLY
 * (3.4c prompt 3). The old cycle crossed two fills with dash patterns, and
 * DASHED CONVENTIONALLY MEANS PROVISIONAL — on a tool whose claim is accuracy
 * it implied we were less sure about those panels when all it encoded was a
 * different face. Four opacity steps, consecutive steps far apart, so
 * adjacent faces still read as different at a glance while the distinction
 * carries no confidence meaning. The dashed BUILDING BOX below is untouched:
 * it means extent, and the caption says so. Zero new colour tokens.
 */
const FACE_STYLES: readonly { fillOpacity: number }[] = [
  { fillOpacity: 0.65 },
  { fillOpacity: 0.3 },
  { fillOpacity: 0.5 },
  { fillOpacity: 0.15 },
];

function fmtMetres(value: number | null): string {
  return value !== null ? String(Math.round(value * 100) / 100) : "—";
}

export function AddressRoofSection({
  view,
  jobId,
  onSaved,
  isOpen,
  showsMultiDwellingCaution = false,
  diagram,
}: {
  view: AddressRoofView;
  jobId: string;
  /** 3.14 prompt 6 (D37): called after a PERSISTED save so the results rail
      can answer "what did that change do". Optional — absent means silent,
      and the rail keeps showing the stored run. */
  onSaved?: (change: SizingInputSave) => void;
  isOpen: boolean;
  /** F99 (3.4b) — derived ONCE in siteDetailsView; this section only renders it,
      beside the roof numbers the warning is about. */
  showsMultiDwellingCaution?: boolean;
  /** 3.5 prompt 2 — Google's indicative panel layout over the tile. Optional:
      absent renders exactly the pre-3.5 thumbnail. */
  diagram?: RoofDiagramView;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<"lookup" | "save" | "confirm" | null>(null);
  // The copy plus whether it was an auth failure — the expired-session case adds a
  // /login link, and the installer chooses when to follow it. We NEVER navigate
  // away mid-action: losing a half-filled roof form is worse than the bug fixed.
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);
  const [unsaved, setUnsaved] = React.useState(false);
  const [liveMismatch, setLiveMismatch] = React.useState<
    { jobState: string; geocodedState: string } | null
  >(null);
  const [tileFailed, setTileFailed] = React.useState(false);

  // Manual form state — survives a failed submit intact (never cleared on failure).
  const [formOpen, setFormOpen] = React.useState(false);
  const [basis, setBasis] = React.useState<string>("");
  const [rows, setRows] = React.useState<PlaneFormRow[]>([
    { ...EMPTY_PLANE_FORM_ROW },
  ]);
  // Provenance (3.4-D): true when THIS open was pre-filled from a Google lookup.
  // Pre-filling makes it trivially easy to open a lookup result, pick "From plans"
  // and save unchanged — laundering an unverified lookup into the highest-trust
  // source. The saved row records where the numbers started; convenience must not
  // quietly upgrade how trustworthy a number is.
  const [prefilledFromLookup, setPrefilledFromLookup] = React.useState(false);
  const [omittedPlanes, setOmittedPlanes] = React.useState(0);
  const [usability, setUsability] = React.useState<string>(
    view.usabilityFactor !== null ? String(view.usabilityFactor) : "0.7",
  );
  const [note, setNote] = React.useState("");
  const [rowErrors, setRowErrors] = React.useState<PlaneRowError[]>([]);
  const [basisError, setBasisError] = React.useState<string | null>(null);

  function failed(kind: ApiErrorKind, status: number) {
    setActionError({ ...clientActionErrorCopy(kind, status), isAuth: kind === "auth" });
  }

  async function lookup() {
    if (busy) return; // two rapid clicks: the second is a no-op — every call is billable
    setBusy("lookup");
    setActionError(null);
    setUnsaved(false);
    setLiveMismatch(null);
    const result = await postJson<Record<string, unknown>>("/api/roof/geometry", {
      address: view.address,
      job_id: jobId,
    });
    try {
      if (!result.ok) {
        failed(result.kind, result.status);
        return;
      }
      const data = result.data ?? {};
      if (data.persisted === false) setUnsaved(true);
      else onSaved?.({ kind: "physics" }); // a new roof: the engine re-costs
      const cc = data.site_cross_check;
      if (typeof cc === "object" && cc !== null) {
        const c = cc as Record<string, unknown>;
        if (c.mismatch === true) {
          setLiveMismatch({
            jobState: String(c.job_state ?? "—"),
            geocodedState: String(c.geocoded_state ?? "—"),
          });
        }
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  /**
   * 3.4c prompt 4 (D24): record that the INSTALLER confirmed this roof. The
   * source is set by the route handler, never chosen here — a chooser would
   * store a claim nothing can check (D29); "customer" is row 8.4's, answered
   * on the homeowner's own phone. NEVER optimistic: the confirmed state
   * renders only from the server re-read, so a false tick cannot appear
   * before the write is stored.
   */
  async function confirmRoof() {
    if (busy) return;
    setBusy("confirm");
    setActionError(null);
    try {
      const result = await postJson<Record<string, unknown>>("/api/roof/confirm", {
        job_id: jobId,
      });
      if (!result.ok) {
        failed(result.kind, result.status);
        return;
      }
      if ((result.data ?? {}).confirmed !== true) {
        // The backend reported a failure inside a 200 (its _persist rule).
        setActionError({
          heading: "The roof could not be confirmed",
          body: "The confirmation was not stored — try again in a moment.",
          isAuth: false,
        });
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function validateForm(): boolean {
    let ok = true;
    if (!basis) {
      setBasisError("Choose how the measurements were taken.");
      ok = false;
    } else {
      setBasisError(null);
    }
    const errors: PlaneRowError[] = rows.map((row) => {
      const err: PlaneRowError = {};
      const azimuth = planeAzimuth(row);
      if (azimuth === null || azimuth < 0 || azimuth > 359.9) {
        err.direction = "Direction must be 0–359.9°.";
        ok = false;
      }
      const pitch = Number(row.pitch);
      if (row.pitch.trim() === "" || !Number.isFinite(pitch) || pitch < 0 || pitch > 60) {
        err.pitch = "Pitch must be 0–60°.";
        ok = false;
      }
      const area = Number(row.area);
      if (row.area.trim() === "" || !Number.isFinite(area) || area <= 0) {
        err.area = "Area must be greater than 0.";
        ok = false;
      }
      return err;
    });
    setRowErrors(errors);
    return ok;
  }

  async function save() {
    if (busy) return;
    if (!validateForm()) return; // never submit a knowingly invalid body
    setBusy("save");
    setActionError(null);
    setUnsaved(false);
    try {
      const usabilityNum = Number(usability);
      const result = await postJson<Record<string, unknown>>("/api/roof/manual", {
        job_id: jobId,
          basis,
          planes: rows.map((row) => ({
            azimuth: planeAzimuth(row),
            pitch: Number(row.pitch),
            area_m2: Number(row.area),
            label: row.label.trim() || null,
          })),
          prefilled_from_lookup: prefilledFromLookup,
        usability_factor:
          Number.isFinite(usabilityNum) && usabilityNum > 0 ? usabilityNum : null,
        note: note.trim() || null,
      });
      if (!result.ok) {
        failed(result.kind, result.status);
        return; // the form stays open, values intact
      }
      const data = result.data ?? {};
      if (data.persisted === false) setUnsaved(true);
      else onSaved?.({ kind: "physics" }); // a new roof: the engine re-costs
      closeForm();
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Open the form, ALWAYS from the stored roof — never from whatever was left in
   * state last time. Pre-fills from a lookup as well as a manual entry, so
   * correcting the one number the product just told you to doubt is an edit
   * rather than a full re-entry.
   *
   * `basis` is deliberately NOT carried over and NOT defaulted: the installer is
   * being asked where the numbers they are about to save came from, and after an
   * edit that answer may have changed.
   */
  function openForm() {
    setActionError(null);
    setBasis("");
    setBasisError(null);
    setRowErrors([]);
    setNote(view.note ?? "");

    const mapped = planeFormRowsFromView(view.planes);
    if (mapped.length > 0) {
      // Google can return more faces than the manual endpoint accepts (Malvern
      // returned 15). Pre-fill the first 12 and SAY how many were left out —
      // never truncate silently, and never submit 15 and take a 422.
      setRows(mapped.slice(0, MAX_FORM_PLANES));
      setOmittedPlanes(Math.max(0, mapped.length - MAX_FORM_PLANES));
      setPrefilledFromLookup(
        view.state === "found" || view.state === "low_confidence",
      );
    } else {
      setRows([{ ...EMPTY_PLANE_FORM_ROW }]);
      setOmittedPlanes(0);
      setPrefilledFromLookup(false);
    }
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setPrefilledFromLookup(false);
    setOmittedPlanes(0);
  }

  const lookupBusy = busy === "lookup";
  const hasPlanes = view.planes.length > 0;
  const fromLookupState = view.state === "found" || view.state === "low_confidence";
  // What the form is doing, not merely which state we are in.
  const formHeading = !hasPlanes
    ? "Enter the roof"
    : fromLookupState
      ? "Correct the roof"
      : "Edit the roof";
  const manualTriggerLabel = !hasPlanes
    ? "Enter it from plans"
    : fromLookupState
      ? "Correct these values"
      : "Edit the roof";

  const planeTable =
    view.planes.length > 0 ? (
      <div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Direction</TableHead>
              <TableHead>Pitch</TableHead>
              <TableHead>Area</TableHead>
              <TableHead>Usable</TableHead>
              <TableHead>Panels</TableHead>
              <TableHead>kW</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.planes.map((plane) => (
              <TableRow key={plane.index}>
                <TableCell className="text-body text-foreground">
                  {/* F168: the direction spelled out, verbatim from the view —
                      never composed here. The degrees stay for the installer
                      who thinks in numbers. */}
                  {plane.orientationLabel !== null ? (
                    <>
                      {plane.orientationLabel}
                      {plane.azimuth !== null ? (
                        <span className="ml-1 text-caption text-muted-foreground">
                          ({fmt(plane.azimuth, 0, "°")})
                        </span>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                  {plane.label ? (
                    <span className="ml-1 text-caption text-muted-foreground">
                      {plane.label}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="metric-sm">{fmt(plane.pitch, 0, "°")}</TableCell>
                {/* F94: the view's rounded labels, never raw numbers — the raw
                    values stay on the view for 4.13 and any future tooltip. */}
                <TableCell className="metric-sm">{plane.areaM2Label ?? "—"}</TableCell>
                <TableCell className="metric-sm">
                  {plane.usableAreaM2Label ?? "—"}
                </TableCell>
                <TableCell
                  className={
                    plane.countSource === "roof_area"
                      ? "metric-sm text-muted-foreground"
                      : "metric-sm"
                  }
                >
                  {fmt(plane.panelCount, 0)}
                  {/* F231: where this face's number came from, in the view's
                      own words — an area-counted face is a different KIND of
                      number and must look like one. */}
                  <span className="block text-caption text-muted-foreground">
                    {plane.countSourceLabel}
                  </span>
                </TableCell>
                <TableCell className="metric-sm">{plane.kwpLabel ?? "—"}</TableCell>
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="text-label text-foreground">
                Total
              </TableCell>
              <TableCell className="metric-sm">{view.totals.panels}</TableCell>
              <TableCell className="metric-sm">
                {view.totalKwpLabel ?? fmt(view.totals.kwp, 2)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        {view.panelLabel || view.usabilityFactor !== null ? (
          <p className="mt-1 text-caption text-muted-foreground">
            {view.panelLabel ? `Scaled to ${view.panelLabel}` : null}
            {view.panelLabel && view.usabilityFactor !== null ? " · " : null}
            {view.usabilityFactor !== null
              ? `${Math.round(view.usabilityFactor * 100)}% of each face treated as usable`
              : null}
          </p>
        ) : null}
        {/* Step 5 (3.4c prompt 3): the comparison and its wording live in
            lib/worksheet.ts; this component only renders the result. */}
        {view.panelMismatchNotice ? (
          <div className="mt-2">
            <Notice
              tone={view.panelMismatchNotice.tone}
              title={view.panelMismatchNotice.title}
            >
              {view.panelMismatchNotice.body}
            </Notice>
          </div>
        ) : null}
      </div>
    ) : null;

  const thumbnail = (() => {
    const diagramActive = diagram !== undefined && diagram.show;
    // 1b (3.5 prompt 2): the tile is REQUESTED centred on the exact point the
    // overlay projects against (building_center, with the fitted zoom). If the
    // request centre and the projection origin ever differ, every drawn shape
    // is offset by exactly that difference — which looks like a rotation bug
    // and is not one. Without a diagram frame, the pre-3.5 request stands.
    const useDiagramTile =
      diagramActive && diagram.tileLat !== null && diagram.tileLng !== null;
    const hasCoords =
      useDiagramTile || (view.lat !== null && view.lng !== null);
    const showImage = hasCoords && isOpen && !tileFailed;
    // scale=2 sharpens the photo WITHOUT changing its ground coverage, so the
    // 0 0 640 360 viewBox and every projected coordinate are untouched by it.
    const tileSrc = useDiagramTile
      ? `/api/roof/tile?lat=${diagram.tileLat}&lng=${diagram.tileLng}&zoom=${diagram.zoom}&scale=${TILE_IMG_SCALE}`
      : `/api/roof/tile?lat=${view.lat}&lng=${view.lng}`;
    // No overlay floating on an empty background: it exists only while the
    // tile <img> does. pointer-events-none — the picture is not a control.
    const overlay =
      showImage &&
      diagramActive &&
      (diagram.rects.length > 0 || diagram.buildingBox !== null) ? (
        <svg
          viewBox={`0 0 ${TILE_W} ${TILE_H}`}
          preserveAspectRatio="xMidYMid slice"
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {/* Back to front: the measured extent first (an axis-aligned BOX,
              never a roof outline), then Google's panels over it. */}
          {diagram.buildingBox ? (
            <rect
              x={diagram.buildingBox.x}
              y={diagram.buildingBox.y}
              width={diagram.buildingBox.width}
              height={diagram.buildingBox.height}
              fill="none"
              className="stroke-primary"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
          ) : null}
          {diagram.rects.map((r, i) => {
            // Inset each rectangle so neighbouring panels keep a visible gap
            // and stay individually countable — display only, the stored
            // geometry is untouched. Capped at 10% of the smaller side so tiny
            // rectangles at low zoom never invert.
            const inset = Math.min(1.25, r.widthPx * 0.1, r.heightPx * 0.1);
            const style = FACE_STYLES[r.segmentIndex % FACE_STYLES.length];
            return (
              <g
                key={i}
                transform={`translate(${r.cx} ${r.cy}) rotate(${r.rotationDeg})`}
              >
                <rect
                  x={-r.widthPx / 2 + inset}
                  y={-r.heightPx / 2 + inset}
                  width={r.widthPx - 2 * inset}
                  height={r.heightPx - 2 * inset}
                  className="fill-primary stroke-primary"
                  fillOpacity={style.fillOpacity}
                  strokeOpacity={1}
                  strokeWidth={1}
                />
              </g>
            );
          })}
        </svg>
      ) : null;
    return (
      // Full section width — this diagram is the deliverable of row 3.5 and
      // has to be large enough to answer "did we measure THIS building".
      <figure className="w-full">
        {/* `relative` anchors the overlay; aspect-video is 16:9 = 640/360, the
            equality lib/worksheet.ts documents and the suite asserts. */}
        <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-bg-subtle">
          {showImage ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={tileSrc}
                alt={`Satellite view of ${view.address}`}
                className="h-full w-full object-cover"
                onError={() => setTileFailed(true)}
              />
              {overlay}
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="px-4 text-center text-caption text-muted-foreground">
                {hasCoords ? "The map is unavailable right now." : "No aerial view for this roof."}
              </span>
            </div>
          )}
        </div>
        {diagramActive && diagram.reason === null ? (
          <>
            {/* F234: LEAD WITH THE QUESTION the picture answers — never with
                a layout claim. The roughness is stated up front because it is
                EVIDENCE, not a defect (F107: never fit the overlay to the
                roof — tidy is what would have hidden the pergola). */}
            <p className="mt-1 text-caption text-foreground">
              Check this picture for two things: is this the right building,
              and is every shaded shape really a roof surface? The panels are
              drawn where Google measured them, but the photo comes from a
              different supplier, so they will sit roughly — judge the
              building, not the layout.
            </p>
            {/* The specifications FOLLOW; they do not lead (F234). */}
            <p className="mt-1 text-caption text-muted-foreground">
              Google drew {diagram.panelCount} panels at{" "}
              {fmtMetres(diagram.panelWidthM)} m × {fmtMetres(diagram.panelHeightM)} m
              {diagram.panelCapacityW !== null
                ? `, ${Math.round(diagram.panelCapacityW)} W each`
                : null}
              .
              {diagram.buildingBox
                ? " The dashed box is the extent of the area Google measured."
                : null}
            </p>
            {/* The panel-identity gap (found on screen 2026-08-25): the TRUE
                half of the deleted different-panel sentence — it describes
                the panel DRAWN, stated separately from the count, which the
                reconciliation below explains. */}
            {diagram.panelCapacityW !== null && view.panelLabel ? (
              <p className="mt-1 text-caption text-muted-foreground">
                The drawn panels are Google&apos;s{" "}
                {Math.round(diagram.panelCapacityW)} W assumption; the table
                above is scaled to {view.panelLabel} — the same roof, two
                panel models.
              </p>
            ) : null}
          </>
        ) : null}
        {diagramActive && diagram.reason !== null ? (
          <p className="mt-1 text-caption text-muted-foreground">
            {DIAGRAM_REASON_COPY[diagram.reason]}
            {diagram.buildingBox
              ? " The dashed box is the extent of the area Google measured."
              : null}
          </p>
        ) : null}
        {/* F231: the TRUE account of any gap between Google's count and the
            table's, assembled face-by-face in lib/worksheet.ts. It replaces
            the deleted different-panel sentence, which was FALSE on
            a57e13f1 — the two agree on every face Google assessed there, and
            a plausible wrong cause stops the reader looking. Rendered for
            LOOKUP roofs only: on a manual roof there is no Google side to
            reconcile against. */}
        {(view.state === "found" || view.state === "low_confidence") &&
        view.countReconciliation?.explanation ? (
          <p className="mt-1 text-caption text-muted-foreground">
            {view.countReconciliation.explanation}
          </p>
        ) : null}
        <figcaption className="mt-1 text-caption text-muted-foreground">
          {[
            view.imageryDate ? `Imagery ${view.imageryDate}` : null,
            view.imageryQualityLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
          {showsGoogleSolarAttribution(view) ? (
            <>
              {view.imageryDate || view.imageryQualityLabel ? " · " : null}
              Includes solar data from Google
            </>
          ) : null}
        </figcaption>
      </figure>
    );
  })();

  const manualForm = formOpen ? (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      <h3 className="text-h3 text-foreground">{formHeading}</h3>

      {prefilledFromLookup ? (
        // D25: true of every pre-filled form — a method fact, quiet. The object
        // (and its unchanged wording) lives in lib/worksheet.ts.
        <NoticeCaption icon={PREFILL_FROM_LOOKUP_CAPTION.icon ?? "info"}>
          {PREFILL_FROM_LOOKUP_CAPTION.title}. {PREFILL_FROM_LOOKUP_CAPTION.body}
        </NoticeCaption>
      ) : null}
      {omittedPlanes > 0 ? (
        <Notice tone="caution" title={`Only the first ${MAX_FORM_PLANES} faces are shown`}>
          This roof has {omittedPlanes + MAX_FORM_PLANES} faces and a manual entry
          accepts {MAX_FORM_PLANES}, so {omittedPlanes}{" "}
          {omittedPlanes === 1 ? "was" : "were"} left out. Saving replaces the roof
          with what you see here.
        </Notice>
      ) : null}

      <div>
        <label className="text-label text-foreground" htmlFor="roof-basis">
          How did you get these measurements?
        </label>
        <div className="mt-1 max-w-[280px]">
          <Select value={basis} onValueChange={(v) => { setBasis(v); setBasisError(null); }}>
            <SelectTrigger id="roof-basis" aria-label="Measurement basis">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="plans">From plans</SelectItem>
              <SelectItem value="site_measure">From a site measure</SelectItem>
              <SelectItem value="estimate">Best estimate</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {basisError ? (
          <p className="mt-1 text-caption text-destructive">{basisError}</p>
        ) : null}
      </div>

      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-caption text-muted-foreground" htmlFor={`plane-dir-${i}`}>
              Direction
            </label>
            <div className="mt-1 w-[170px]">
              <Select
                value={row.direction}
                onValueChange={(v) =>
                  setRows((r) => r.map((x, j) => (j === i ? { ...x, direction: v } : x)))
                }
              >
                <SelectTrigger id={`plane-dir-${i}`} aria-label={`Roof face ${i + 1} direction`}>
                  <SelectValue placeholder="Facing…" />
                </SelectTrigger>
                <SelectContent>
                  {COMPASS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {row.direction === "exact" ? (
            <div>
              <label className="text-caption text-muted-foreground" htmlFor={`plane-deg-${i}`}>
                Degrees
              </label>
              <Input
                id={`plane-deg-${i}`}
                step="0.1"
                className="mt-1 w-[110px]"
                type="number"
                inputMode="decimal"
                min="0"
                max="359.9"
                placeholder="e.g. 247"
                value={row.exactDegrees}
                onChange={(e) =>
                  setRows((r) =>
                    r.map((x, j) => (j === i ? { ...x, exactDegrees: e.target.value } : x)),
                  )
                }
              />
            </div>
          ) : null}
          <div>
            <label className="text-caption text-muted-foreground" htmlFor={`plane-pitch-${i}`}>
              Pitch (°)
            </label>
            <Input
              id={`plane-pitch-${i}`}
              step="1"
              className="mt-1 w-[110px]"
              type="number"
              inputMode="decimal"
              min="0"
              max="60"
              placeholder="e.g. 22"
              value={row.pitch}
              onChange={(e) =>
                setRows((r) => r.map((x, j) => (j === i ? { ...x, pitch: e.target.value } : x)))
              }
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground" htmlFor={`plane-area-${i}`}>
              Area (m²)
            </label>
            <Input
              id={`plane-area-${i}`}
              step="1"
              className="mt-1 w-[110px]"
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="e.g. 45"
              value={row.area}
              onChange={(e) =>
                setRows((r) => r.map((x, j) => (j === i ? { ...x, area: e.target.value } : x)))
              }
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground" htmlFor={`plane-label-${i}`}>
              Label (optional)
            </label>
            <Input
              id={`plane-label-${i}`}
              className="mt-1 w-[170px]"
              maxLength={80}
              placeholder="e.g. main north face"
              value={row.label}
              onChange={(e) =>
                setRows((r) => r.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
              }
            />
          </div>
          {i > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove roof face ${i + 1}`}
              onClick={() => {
                setRows((r) => r.filter((_, j) => j !== i));
                setRowErrors((r) => r.filter((_, j) => j !== i));
              }}
            >
              <Minus aria-hidden="true" className="h-4 w-4" />
            </Button>
          ) : null}
          {rowErrors[i] && (rowErrors[i].direction || rowErrors[i].pitch || rowErrors[i].area) ? (
            <p className="w-full text-caption text-destructive">
              {[rowErrors[i].direction, rowErrors[i].pitch, rowErrors[i].area]
                .filter(Boolean)
                .join(" ")}
            </p>
          ) : null}
        </div>
      ))}
      {rows.length < MAX_FORM_PLANES ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRows((r) => [...r, { ...EMPTY_PLANE_FORM_ROW }])}
          >
            + Add another roof face
          </Button>
        </div>
      ) : null}

      <OverrideDrawer>
        <div className="flex items-center gap-2 pt-1">
          <label className="text-caption text-muted-foreground" htmlFor="roof-usability">
            Usable-area factor
          </label>
          <Input
            id="roof-usability"
            className="w-[90px]"
            type="number"
            inputMode="decimal"
            step="0.05"
            min="0.1"
            max="1"
            placeholder="e.g. 0.7"
            value={usability}
            onChange={(e) => setUsability(e.target.value)}
          />
        </div>
        <p className="mt-1">
          How much of each face is treated as usable after setbacks, vents and walkways.
        </p>
      </OverrideDrawer>

      <div>
        <label className="text-caption text-muted-foreground" htmlFor="roof-note">
          Note (optional)
        </label>
        <Input
          id="roof-note"
          className="mt-1"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. from the builder's plans, May 2026"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save this roof"}
        </Button>
        <Button variant="ghost" onClick={closeForm} disabled={busy !== null}>
          Cancel
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-foreground">{view.address}</p>

      {/* D25 ordering: every FINDING (bordered notice) renders above every
          method-fact CAPTION. The level is decided in lib/worksheet.ts, never
          here; this block only partitions. Wording untouched (3.4c owns it). */}
      {(
        [
          view.confirmedNotice,
          view.notice,
          ...view.confidenceNotices,
          view.solarExpiredNotice,
        ].filter(
          (n): n is RoofNoticeView => n !== null && n.level === "notice",
        )
      ).map((notice, i) => (
        <Notice key={`finding-${i}`} tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notice>
      ))}
      {view.crossCheck?.mismatch || liveMismatch ? (
        <Notice tone="caution" title="The address geocodes to a different state">
          The job was set up as {view.crossCheck?.jobState ?? liveMismatch?.jobState}, but
          the address geocodes to{" "}
          {view.crossCheck?.geocodedState ?? liveMismatch?.geocodedState}. Tariff and
          rebate figures were set from the address — worth checking before quoting.
        </Notice>
      ) : null}
      {unsaved ? (
        <Notice tone="caution" title="This roof could not be saved">
          The lookup worked but the result could not be stored — try again in a moment.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="problem" title={actionError.heading}>
          {actionError.body}
          {actionError.isAuth ? (
            <>
              {" "}
              <Link href="/login" className="text-primary underline">
                Go to sign in
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}

      {/* The quiet captions — method facts, always BELOW every finding (D25).
          Same objects, same wording; only the level moved them down here. */}
      {(
        [
          view.notice,
          showsMultiDwellingCaution ? MULTI_DWELLING_CAPTION : null,
          view.staleNotice,
        ].filter(
          (n): n is RoofNoticeView => n !== null && n.level === "caption",
        )
      ).map((caption, i) => (
        <NoticeCaption key={`caption-${i}`} icon={caption.icon ?? "info"}>
          {caption.title ? `${caption.title}. ` : null}
          {caption.body}
        </NoticeCaption>
      ))}

      {view.state !== "none" && view.state !== "not_found" ? thumbnail : null}
      {planeTable}
      {view.note ? (
        <p className="text-caption text-muted-foreground">Note: {view.note}</p>
      ) : null}

      {!formOpen ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            {view.state === "none" ? (
              <>
                <Button onClick={lookup} disabled={busy !== null}>
                  {lookupBusy ? "Looking up…" : "Look up the roof"}
                </Button>
                <Button variant="secondary" onClick={openForm} disabled={busy !== null}>
                  Enter it from plans
                </Button>
              </>
            ) : null}
            {view.state === "found" ? (
              <>
                {/* D24 order: confirm-or-correct is the next step; the re-run
                    comes last. Confirm yields primary to the refresh when the
                    Solar Data has expired. The control exists only while
                    unconfirmed (view.showsConfirmControl) — never disabled. */}
                {view.showsConfirmControl ? (
                  <Button
                    variant={view.solarDataExpired ? "secondary" : "primary"}
                    onClick={confirmRoof}
                    disabled={busy !== null}
                  >
                    {busy === "confirm" ? "Confirming…" : "Confirm this roof"}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={openForm} disabled={busy !== null}>
                  {manualTriggerLabel}
                </Button>
                <Button
                  variant={view.solarDataExpired ? "primary" : "secondary"}
                  onClick={lookup}
                  disabled={busy !== null}
                >
                  {lookupBusy
                    ? "Looking up…"
                    : view.solarDataExpired
                      ? "Refresh roof data from Google"
                      : "Look up again"}
                </Button>
              </>
            ) : null}
            {view.state === "low_confidence" ? (
              <>
                <Button onClick={openForm} disabled={busy !== null}>
                  {manualTriggerLabel}
                </Button>
                {/* An installer may know a flagged roof is fine (Mayur,
                    2026-08-14) — confirming stays available, correcting stays
                    first. */}
                {view.showsConfirmControl ? (
                  <Button
                    variant="secondary"
                    onClick={confirmRoof}
                    disabled={busy !== null}
                  >
                    {busy === "confirm" ? "Confirming…" : "Confirm this roof"}
                  </Button>
                ) : null}
                {/* Restored at 3.4-D: a low-confidence roof is exactly where you
                    might re-run after checking, and the retry had vanished.
                    3.5b: when the Solar Data has expired the same handler is the
                    refresh — one Google call, appended as a new row, restarting
                    the 30-day clock. */}
                <Button
                  variant={view.solarDataExpired ? "primary" : "secondary"}
                  onClick={lookup}
                  disabled={busy !== null}
                >
                  {lookupBusy
                    ? "Looking up…"
                    : view.solarDataExpired
                      ? "Refresh roof data from Google"
                      : "Look up again"}
                </Button>
              </>
            ) : null}
            {view.state === "not_found" ? (
              // No retry here: the address has no coverage, and offering a retry
              // that cannot succeed is worse than not offering it.
              <Button onClick={openForm} disabled={busy !== null}>
                {manualTriggerLabel}
              </Button>
            ) : null}
            {view.state === "manual" ? (
              <>
                <Button variant="secondary" onClick={openForm} disabled={busy !== null}>
                  {manualTriggerLabel}
                </Button>
                {view.lat !== null && view.lng !== null ? (
                  <Button variant="secondary" onClick={lookup} disabled={busy !== null}>
                    {lookupBusy ? "Looking up…" : "Try the lookup"}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          {view.state === "none" ? (
            <p className="text-caption text-muted-foreground">
              Plans give the most accurate roof we can get. Use them whenever you have them.
            </p>
          ) : null}
        </div>
      ) : null}

      {manualForm}
    </div>
  );
}
