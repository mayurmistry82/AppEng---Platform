"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
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
  planeFormRowsFromView,
  showsGoogleSolarAttribution,
  type AddressRoofView,
  type PlaneFormRow,
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

export function AddressRoofSection({
  view,
  jobId,
  isOpen,
  showsMultiDwellingCaution = false,
}: {
  view: AddressRoofView;
  jobId: string;
  isOpen: boolean;
  /** F99 (3.4b) — derived ONCE in siteDetailsView; this section only renders it,
      beside the roof numbers the warning is about. */
  showsMultiDwellingCaution?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<"lookup" | "save" | null>(null);
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
                  {plane.azimuthLabel !== null && plane.azimuth !== null
                    ? `${plane.azimuthLabel} (${fmt(plane.azimuth, 0, "°")})`
                    : "—"}
                  {plane.label ? (
                    <span className="ml-1 text-caption text-muted-foreground">
                      {plane.label}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="metric-sm">{fmt(plane.pitch, 0, "°")}</TableCell>
                <TableCell className="metric-sm">{fmt(plane.areaM2, 1, " m²")}</TableCell>
                <TableCell className="metric-sm">
                  {fmt(plane.usableAreaM2, 1, " m²")}
                </TableCell>
                <TableCell className="metric-sm">{fmt(plane.panelCount, 0)}</TableCell>
                <TableCell className="metric-sm">{fmt(plane.kwp, 2)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="text-label text-foreground">
                Total
              </TableCell>
              <TableCell className="metric-sm">{view.totals.panels}</TableCell>
              <TableCell className="metric-sm">{fmt(view.totals.kwp, 2)}</TableCell>
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
      </div>
    ) : null;

  const thumbnail = (() => {
    const hasCoords = view.lat !== null && view.lng !== null;
    const showImage = hasCoords && isOpen && !tileFailed;
    return (
      <figure className="w-full max-w-[520px]">
        <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-bg-subtle">
          {showImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/roof/tile?lat=${view.lat}&lng=${view.lng}`}
              alt={`Satellite view of ${view.address}`}
              className="h-full w-full object-cover"
              onError={() => setTileFailed(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="px-4 text-center text-caption text-muted-foreground">
                {hasCoords ? "The map is unavailable right now." : "No aerial view for this roof."}
              </span>
            </div>
          )}
        </div>
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
        <Notice tone="caution" title="These values came from the lookup">
          They are Google&apos;s numbers, not yours. Change what is wrong, and only
          choose a source below that matches how you actually checked it.
        </Notice>
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

      {view.notice ? (
        <Notice tone={view.notice.tone} title={view.notice.title}>
          {view.notice.body}
        </Notice>
      ) : null}
      {/* One caution per low-confidence cause (3.4-C), between the state notice
          and the stale-imagery one. Never hides a number — the plane table below
          renders unchanged. */}
      {view.confidenceNotices.map((notice, i) => (
        <Notice key={`confidence-${i}`} tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notice>
      ))}
      {view.solarExpiredNotice ? (
        <Notice tone={view.solarExpiredNotice.tone} title={view.solarExpiredNotice.title}>
          {view.solarExpiredNotice.body}
        </Notice>
      ) : null}
      {showsMultiDwellingCaution ? (
        <Notice tone="caution" title="The roof lookup may not be this dwelling">
          Google returns the one building nearest the address. On a
          multi-dwelling site that may not be this one. Check the roof against
          the plans, and note that a shared roof usually needs body corporate
          approval.
        </Notice>
      ) : null}
      {view.staleNotice ? (
        <Notice tone={view.staleNotice.tone} title={view.staleNotice.title}>
          {view.staleNotice.body}
        </Notice>
      ) : null}
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
                <Button variant="secondary" onClick={openForm} disabled={busy !== null}>
                  {manualTriggerLabel}
                </Button>
              </>
            ) : null}
            {view.state === "low_confidence" ? (
              <>
                <Button onClick={openForm} disabled={busy !== null}>
                  {manualTriggerLabel}
                </Button>
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
