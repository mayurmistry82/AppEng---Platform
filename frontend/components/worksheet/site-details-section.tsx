"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requestJson } from "@/lib/client-api";
import { clientActionErrorCopy } from "@/lib/jobs";
import type { SiteDetailsView, SizingInputSave } from "@/lib/worksheet";

/**
 * Site details (checklist 3.4b) — site-visit fields, governed by D5: Mayur's
 * process is enquiry → size at the desk → customer accepts → THEN site visit.
 * Every field here is optional, none of it gates sizing or the next section,
 * and none of it feeds the accuracy meter or the completeness gate. The caption
 * at the top says so on screen, which is what stops an installer feeling
 * blocked by a section they cannot answer at the desk.
 *
 * The database is the single source of truth: the server page hands in the
 * view, saving PATCHes only the fields that changed (cleared → explicit null,
 * untouched → absent — the backend treats those differently, and conflating
 * them wipes another visit's data), then router.refresh() re-reads.
 *
 * F99 / 3.4c prompt 4 (item d): the multi-dwelling caution renders in ONE
 * place — Address & roof — because it doubts the ROOF LOOKUP and belongs
 * beside the numbers it doubts, not beside the form field that drives it.
 * This form only stores the dwelling type; the stored value flows to the
 * caution through siteDetailsView.showsMultiDwellingCaution. One derivation,
 * one renderer. (The old immediate pre-save render here said the same words
 * with the same weight twice on one screen — the trade is deliberate.)
 *
 * 3.18 prompt 3 (F260): when nothing is stored and the ADDRESS is what the
 * caution is firing from, the dwelling-type field carries one line saying so.
 * It is NOT the caution restated — that doubts the roof and stays on Address &
 * roof; this explains where THIS FIELD's value is coming from and how to take
 * it over. The wording is composed in siteDetailsView, never here (D25, F128).
 */

const DWELLING_OPTIONS = [
  { value: "detached", label: "Detached house" },
  { value: "townhouse", label: "Townhouse" },
  { value: "unit", label: "Unit" },
  { value: "other", label: "Other" },
] as const;

// The database has NO constraint on roof_material — this list plus the backend
// whitelist's normalisation are the only guards. Values stored lowercase.
const ROOF_MATERIAL_OPTIONS = [
  { value: "tile", label: "Tile" },
  { value: "colorbond or metal", label: "Colorbond or metal" },
  { value: "concrete tile", label: "Concrete tile" },
  { value: "slate", label: "Slate" },
  { value: "membrane", label: "Membrane" },
  { value: "other", label: "Other" },
] as const;

const PHASE_OPTIONS = [
  { value: "single", label: "Single phase" },
  { value: "three", label: "Three phase" },
] as const;

interface FormState {
  dwellingType: string;
  storeys: string;
  roofMaterial: string;
  yearBuilt: string;
  bedrooms: string;
  floorAreaM2: string;
  electricalPhase: string;
}

function fromView(view: SiteDetailsView): FormState {
  return {
    dwellingType: view.dwellingTypeField.text,
    storeys: view.storeys.text,
    roofMaterial: view.roofMaterial.text,
    yearBuilt: view.yearBuilt.text,
    bedrooms: view.bedrooms.text,
    floorAreaM2: view.floorAreaM2.text,
    electricalPhase: view.electricalPhase.text,
  };
}

/** form field -> API field, for the PATCH payload. */
const API_FIELDS: Record<keyof FormState, string> = {
  dwellingType: "dwelling_type",
  storeys: "storeys",
  roofMaterial: "roof_material",
  yearBuilt: "year_built",
  bedrooms: "bedrooms",
  floorAreaM2: "floor_area_m2",
  electricalPhase: "electrical_phase",
};

const NUMERIC_FIELDS: ReadonlySet<keyof FormState> = new Set([
  "storeys",
  "yearBuilt",
  "bedrooms",
  "floorAreaM2",
] as const);

const BOUNDS: Partial<Record<keyof FormState, { min: number; max: number; label: string }>> = {
  storeys: { min: 1, max: 5, label: "Storeys must be 1–5." },
  yearBuilt: { min: 1800, max: 2100, label: "Year built must be 1800–2100." },
  bedrooms: { min: 0, max: 20, label: "Bedrooms must be 0–20." },
  floorAreaM2: { min: 0.1, max: 2000, label: "Floor area must be 1–2000 m²." },
};

export function SiteDetailsSection({
  view,
  jobId,
  onSaved,
}: {
  view: SiteDetailsView;
  jobId: string;
  /** 3.14 prompt 6 (D37): called after a PERSISTED save so the results rail
      can answer "what did that change do". Optional — absent means silent,
      and the rail keeps showing the stored run. */
  onSaved?: (change: SizingInputSave) => void;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => fromView(view));
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<
    Partial<Record<keyof FormState, string>>
  >({});
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);
  const [savedTick, setSavedTick] = React.useState(false);

  const baseline = fromView(view);
  const dirtyFields = (Object.keys(form) as (keyof FormState)[]).filter(
    (key) => form[key] !== baseline[key],
  );
  const dirty = dirtyFields.length > 0;

  function set(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((e) => ({ ...e, [key]: undefined }));
    setSavedTick(false);
  }

  function validate(): boolean {
    const errors: Partial<Record<keyof FormState, string>> = {};
    for (const key of dirtyFields) {
      if (!NUMERIC_FIELDS.has(key)) continue;
      const text = form[key].trim();
      if (text === "") continue; // cleared is valid — it becomes an explicit null
      const value = Number(text);
      const bound = BOUNDS[key];
      if (!Number.isFinite(value) || (bound && (value < bound.min || value > bound.max))) {
        errors[key] = bound?.label ?? "Enter a number.";
      }
    }
    setFieldErrors(errors);
    return Object.values(errors).every((e) => !e);
  }

  async function save() {
    if (saving || !dirty) return;
    if (!validate()) return; // never submit a knowingly invalid body
    setSaving(true);
    setActionError(null);
    try {
      // ONLY the changed fields travel. Cleared (non-empty → empty) sends an
      // explicit null so the column is cleared; untouched fields are absent so
      // another visit's data is left alone.
      const payload: Record<string, unknown> = {};
      for (const key of dirtyFields) {
        const text = form[key].trim();
        if (text === "") {
          payload[API_FIELDS[key]] = null;
        } else {
          payload[API_FIELDS[key]] = NUMERIC_FIELDS.has(key) ? Number(text) : text;
        }
      }
      const result = await requestJson<Record<string, unknown>>(
        "PATCH",
        `/api/job/${encodeURIComponent(jobId)}`,
        payload,
      );
      if (!result.ok) {
        const copy = clientActionErrorCopy(result.kind, result.status);
        setActionError({ ...copy, isAuth: result.kind === "auth" });
        return; // values intact, no navigation
      }
      setSavedTick(true);
      onSaved?.({ kind: "physics" }); // site state/postcode price the system
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  // An existing row may hold a roof_material outside the UI list (no DB
  // constraint) — show it as a selected extra option, never silently reset it.
  const roofValue = form.roofMaterial;
  const roofOptions: { value: string; label: string }[] = [...ROOF_MATERIAL_OPTIONS];
  if (roofValue && !roofOptions.some((o) => o.value === roofValue)) {
    roofOptions.push({ value: roofValue, label: `${roofValue} (as stored)` });
  }

  const selectField = (
    id: string,
    label: string,
    key: keyof FormState,
    options: readonly { value: string; label: string }[],
    note?: React.ReactNode,
  ) => (
    <div>
      <label className="text-caption text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <div className="mt-1 w-[200px]">
        <Select value={form[key]} onValueChange={(v) => set(key, v)}>
          <SelectTrigger id={id} aria-label={label}>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {note}
    </div>
  );

  const numberField = (
    id: string,
    label: string,
    key: keyof FormState,
    step: string, // from the field's own unit and its BOUNDS entry above
    placeholder: string, // every numeric placeholder carries "e.g." (F78)
  ) => (
    <div>
      <label className="text-caption text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        className="mt-1 w-[130px]"
        type="number"
        inputMode="decimal"
        step={step}
        placeholder={placeholder}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
      />
      {fieldErrors[key] ? (
        <p className="mt-1 text-caption text-destructive">{fieldErrors[key]}</p>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* D5, made visible — this is what keeps the section from feeling like a gate. */}
      <p className="text-caption text-muted-foreground">
        For the site visit. None of this is needed to size the job — fill it in
        when you have it.
      </p>

      <div className="flex flex-wrap items-start gap-4">
        {selectField(
          "site-dwelling",
          "Dwelling type",
          "dwellingType",
          DWELLING_OPTIONS,
          view.dwellingTypeDerivedNote ? (
            <p className="mt-1 max-w-[200px] text-caption text-muted-foreground">
              {view.dwellingTypeDerivedNote}
            </p>
          ) : null,
        )}
        {numberField("site-storeys", "Storeys", "storeys", "1", "e.g. 1")}
        {selectField("site-roof-material", "Roof material", "roofMaterial", roofOptions)}
        {numberField("site-year", "Year built", "yearBuilt", "1", "e.g. 1995")}
        {numberField("site-bedrooms", "Bedrooms", "bedrooms", "1", "e.g. 3")}
        {numberField("site-floor-area", "Floor area (m²)", "floorAreaM2", "1", "e.g. 180")}
        {selectField(
          "site-phase",
          "Electrical phase",
          "electricalPhase",
          PHASE_OPTIONS,
          <p className="mt-1 max-w-[200px] text-caption text-muted-foreground">
            Sets the export limit later (4.4).
          </p>,
        )}
      </div>

      {/* 3.4c prompt 4 (item d): the multi-dwelling caution no longer renders
          here — Address & roof owns it (see the module docstring). */}
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

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save site details"}
        </Button>
        {dirty ? (
          <span className="text-caption text-muted-foreground">Unsaved changes</span>
        ) : savedTick ? (
          <span className="text-caption text-muted-foreground">Saved</span>
        ) : null}
      </div>
    </div>
  );
}
