"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { NoticeStack } from "@/components/ui/notice-stack";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requestJson } from "@/lib/client-api";
import { clientActionErrorCopy, type ApiErrorKind } from "@/lib/jobs";
import { Input } from "@/components/ui/input";
import { OverrideDrawer } from "@/components/ui/override-drawer";
import {
  CUSTOM_EQUIPMENT_FIELDS,
  EQUIPMENT_KINDS,
  customUnitNotices,
  equipmentSaveNotices,
  type CustomFieldSpec,
  type EquipmentKind,
  type EquipmentKindView,
  type EquipmentOption,
  type EquipmentSpecsView,
  type RoofNoticeView,
  type SizingInputSave,
} from "@/lib/worksheet";

/**
 * Equipment & specs (checklist 3.10) — what the engine builds the system from.
 *
 * SAVE IS ENABLED WHEN NOTHING IS DIRTY, provided the job is not yet
 * confirmed, and that is a deliberate difference from every other section on
 * this worksheet. Pressing Save IS the confirmation (D24's propose-then-
 * confirm shape), and a job sitting on three Autos has nothing to change but
 * still needs confirming — a dirty-only rule would leave the commonest case
 * unconfirmable forever. Once confirmed and not dirty, Save is disabled.
 *
 * The section does NOT gate (see SECTIONS' `gates: false`): sizing is never
 * blocked, and one unpressed button must not stop a quote.
 *
 * "Other / new" custom entry is prompt 5. This screen chooses from what the
 * catalogue endpoint returned and nothing else.
 */

const AUTO_VALUE = "__auto__";

/** 409/422/503 carry a plain-English `detail` written for exactly this. */
function saveErrorCopy(kind: ApiErrorKind, status: number, message: string) {
  if (kind === "http" && message && (status === 409 || status === 422 || status === 503)) {
    return { heading: "That didn't save", body: message };
  }
  return clientActionErrorCopy(kind, status);
}

interface FormState {
  panels: string; // "" = Auto
  inverters: string;
  batteries: string;
}

function fromView(view: EquipmentSpecsView): FormState {
  return {
    panels: view.panels.selectedId ?? "",
    inverters: view.inverters.selectedId ?? "",
    batteries: view.batteries.selectedId ?? "",
  };
}

const API_FIELD: Record<keyof FormState, string> = {
  panels: "equipment_panel_id",
  inverters: "equipment_inverter_id",
  batteries: "equipment_battery_id",
};

const KIND_LABEL: Record<keyof FormState, string> = {
  panels: "Panel",
  inverters: "Inverter",
  batteries: "Battery",
};

export function EquipmentSpecsSection({
  view,
  jobId,
  onSaved,
}: {
  view: EquipmentSpecsView;
  jobId: string;
  /** 3.14b prompt 3 (D37): called after a PERSISTED save that actually MOVED
      one of the three equipment ids, so the results rail re-costs the stored
      system on the newly pinned kit. Optional — absent means silent.

      A CONFIRMATION-ONLY SAVE STAYS SILENT. D30 keeps Save enabled with
      nothing dirty because pressing Save IS the confirmation; that save
      changes no engine input, so announcing it would fire a re-cost that can
      only reproduce the same numbers and would tell the installer something
      changed when nothing did. `dirty` — the flag the button already uses —
      is the test, never a second one. */
  onSaved?: (change: SizingInputSave) => void;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => fromView(view));
  const [saving, setSaving] = React.useState(false);
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);
  const [saveNotices, setSaveNotices] = React.useState<readonly RoofNoticeView[]>([]);
  const [savedTick, setSavedTick] = React.useState(false);

  // ── "Other / new" drawer state (prompt 5) — ALONGSIDE the prompt-4 state,
  // never inside it. draft holds raw strings per backend field name.
  const [drawerKind, setDrawerKind] = React.useState<EquipmentKind>("batteries");
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createNotices, setCreateNotices] = React.useState<readonly RoofNoticeView[]>([]);
  // Units created THIS visit, present locally so the new option can be
  // selected before router.refresh() brings the re-read catalogue (which then
  // contains the same unit — options are deduped by id below).
  const [extraOptions, setExtraOptions] = React.useState<
    Record<EquipmentKind, EquipmentOption[]>
  >({ panels: [], inverters: [], batteries: [] });

  const baseline = React.useMemo(() => fromView(view), [view]);
  const dirty =
    form.panels !== baseline.panels ||
    form.inverters !== baseline.inverters ||
    form.batteries !== baseline.batteries;

  const readOnly = !view.catalogueAvailable;
  // See the header comment: unconfirmed always needs a Save available, even
  // with nothing dirty.
  const canSave = !readOnly && !saving && (dirty || !view.confirmed);

  function choose(kind: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [kind]: value === AUTO_VALUE ? "" : value }));
    setSavedTick(false);
    setSaveNotices([]);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setActionError(null);
    setSaveNotices([]);
    try {
      const payload: Record<string, unknown> = {};
      for (const kind of ["panels", "inverters", "batteries"] as const) {
        if (form[kind] === baseline[kind]) continue; // untouched: absent
        // Auto travels as an EXPLICIT NULL, which clears the column. Absent
        // and null are different facts and the backend treats them so.
        payload[API_FIELD[kind]] = form[kind] === "" ? null : form[kind];
      }
      // Sent EVERY time, changed or not — pressing Save is the confirmation.
      // Never `false`: un-confirming is not something this screen offers;
      // changing a choice simply re-confirms on the next Save.
      payload.equipment_confirmed = true;

      const result = await requestJson<Record<string, unknown>>(
        "PATCH",
        `/api/job/${encodeURIComponent(jobId)}`,
        payload,
      );
      if (!result.ok) {
        const copy = saveErrorCopy(result.kind, result.status, result.message);
        setActionError({ ...copy, isAuth: result.kind === "auth" });
        return; // values intact, no navigation, no tick
      }
      const notices = equipmentSaveNotices(payload, result.data);
      if (notices.length > 0) {
        // A 200 whose row disagrees with what was sent is NOT a save.
        setSaveNotices(notices);
        return;
      }
      setSavedTick(true);
      // Only a save that MOVED a pin is an engine-input change (see the prop).
      // "equipment", not "physics": the re-cost's answer is EXPECTED to be a
      // different system, and the rail must judge it so (3.14b prompt 4).
      if (dirty) onSaved?.({ kind: "equipment" });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function setDraftField(name: string, value: string) {
    setDraft((d) => ({ ...d, [name]: value }));
    setCreateError(null);
  }

  async function createUnit() {
    if (creating || readOnly) return;
    const fields = CUSTOM_EQUIPMENT_FIELDS[drawerKind];
    const missingLabels = fields
      .filter((f) => f.required && !(draft[f.name] ?? "").trim())
      .map((f) => f.label);
    if (missingLabels.length > 0) {
      setCreateError(`Still needed: ${missingLabels.join(", ")}.`);
      return;
    }
    // ONLY fields the installer filled in: an empty optional field is ABSENT
    // from the body — never null, never "". Numbers travel as NUMBERS: the
    // string "12.8" would fail pydantic validation with a 422 the installer
    // cannot act on. Nothing server-fixed (origin, owner, verified, status,
    // promoted_from, id) is ever sent — the backend ignores them, but sending
    // them would state an intent this screen does not have.
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = (draft[field.name] ?? "").trim();
      if (raw === "") continue;
      if (field.type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setCreateError(`${field.label} must be a number.`);
          return;
        }
        body[field.name] = n;
      } else if (field.type === "boolean") {
        body[field.name] = raw === "true";
      } else {
        body[field.name] = raw;
      }
    }
    setCreating(true);
    setCreateError(null);
    setCreateNotices([]);
    try {
      const result = await requestJson<Record<string, unknown>>(
        "POST",
        `/api/equipment/${encodeURIComponent(drawerKind)}`,
        body,
      );
      if (!result.ok) {
        // 422/409 details are written for this screen — show them as-is. The
        // form keeps every typed value: a refusal that empties the form is a
        // second failure on top of the first.
        const copy = saveErrorCopy(result.kind, result.status, result.message);
        setCreateError(copy.body || copy.heading);
        return;
      }
      const newId = typeof result.data.id === "string" ? result.data.id : null;
      if (!newId) {
        // A 201 whose body is unreadable is a failure the installer can see —
        // never invent an id, never select something that might not exist.
        setCreateError("The unit may not have saved — reload before trying again.");
        return;
      }
      const brand = (draft.brand ?? "").trim();
      const model = (draft.model ?? "").trim();
      const label = `${`${brand} ${model}`.trim() || newId} · your own, unverified`;
      // LOCAL first, so the option exists at the moment it is selected; the
      // refreshed catalogue then carries the same unit and dedupe-by-id above
      // keeps it single.
      setExtraOptions((e) => ({
        ...e,
        [drawerKind]: [...e[drawerKind], { id: newId, label, isUserDefined: true }],
      }));
      choose(drawerKind, newId);
      setCreateNotices(customUnitNotices(result.data));
      setDraft({});
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  // Save-attempt notices first, then the view's own — deduped by title;
  // NoticeStack does the D25 ordering (findings above captions).
  const notices: RoofNoticeView[] = [];
  const seen = new Set<string>();
  for (const notice of [...saveNotices, ...view.notices]) {
    if (seen.has(notice.title)) continue;
    seen.add(notice.title);
    notices.push(notice);
  }

  function renderDraftField(field: CustomFieldSpec) {
    const id = `custom-${field.name}`;
    const value = draft[field.name] ?? "";
    const label = field.required ? `${field.label} *` : field.label;
    if (field.type === "enum" || field.type === "boolean") {
      const options =
        field.type === "boolean"
          ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
          : field.options ?? [];
      return (
        <div key={field.name}>
          <label className="text-caption text-muted-foreground" htmlFor={id}>
            {label}
          </label>
          <div className="mt-1 w-[160px]">
            <Select
              value={value}
              onValueChange={(v) => setDraftField(field.name, v)}
              disabled={readOnly}
            >
              <SelectTrigger id={id} aria-label={field.label}>
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
        </div>
      );
    }
    return (
      <div key={field.name}>
        <label className="text-caption text-muted-foreground" htmlFor={id}>
          {label}
        </label>
        <div className="mt-1 flex items-center gap-1.5">
          {field.unit === "$" ? (
            <span className="text-caption text-muted-foreground">$</span>
          ) : null}
          <Input
            id={id}
            className={field.type === "number" ? "w-[110px]" : "w-[160px]"}
            type={field.type === "number" ? "number" : "text"}
            inputMode={field.type === "number" ? "decimal" : undefined}
            step={field.type === "number" ? field.step ?? "1" : undefined}
            value={value}
            onChange={(e) => setDraftField(field.name, e.target.value)}
            disabled={readOnly}
          />
          {field.unit && field.unit !== "$" ? (
            <span className="text-caption text-muted-foreground">{field.unit}</span>
          ) : null}
        </div>
      </div>
    );
  }

  function renderKind(kind: keyof FormState, kindView: EquipmentKindView) {
    const value = form[kind] === "" ? AUTO_VALUE : form[kind];
    // The catalogue's options plus any unit created this visit — deduped by
    // id, so the same unit arriving in the refreshed catalogue does not
    // appear twice.
    const seen = new Set(kindView.options.map((o) => o.id));
    const options = [
      ...kindView.options,
      ...extraOptions[kind].filter((o) => !seen.has(o.id)),
    ];
    // A stored id that is not in the visible list is offered as its own
    // option so the Select shows the real choice rather than snapping to
    // Auto — the view keeps it, and so does the control.
    const missing =
      form[kind] !== "" && !options.some((o) => o.id === form[kind]);
    return (
      <div key={kind} className="min-w-[220px] flex-1">
        <label className="text-caption text-muted-foreground" htmlFor={`equipment-${kind}`}>
          {KIND_LABEL[kind]}
        </label>
        <div className="mt-1">
          <Select
            value={value}
            onValueChange={(v) => choose(kind, v)}
            disabled={readOnly}
          >
            <SelectTrigger id={`equipment-${kind}`} aria-label={KIND_LABEL[kind]}>
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_VALUE}>Auto</SelectItem>
              {missing ? (
                <SelectItem value={form[kind]}>
                  {`${form[kind]} (saved, not in your catalogue)`}
                </SelectItem>
              ) : null}
              {/* Order is the endpoint's — deliberately not re-sorted. */}
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {kindView.emptyList ? (
          <p className="mt-1 text-caption text-muted-foreground">
            No units of this kind are available yet.
          </p>
        ) : null}
        {/* Specs only when something other than Auto is chosen — and for what
            is selected RIGHT NOW, not only for what was last saved, so the
            rows do not blank the moment a dropdown changes. A null spec reads
            "not stated" and never what the engine would assume — see
            SPEC_NOT_STATED in lib/worksheet.ts. */}
        {form[kind] !== "" && (kindView.specsById[form[kind]] ?? []).length > 0 ? (
          <dl className="mt-2 flex flex-col gap-0.5">
            {(kindView.specsById[form[kind]] ?? []).map((spec) => (
              <div key={spec.label} className="flex justify-between gap-3">
                <dt className="text-caption text-muted-foreground">{spec.label}</dt>
                <dd className="text-caption text-foreground tabular-nums">{spec.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        What the engine builds the system from. Auto means EnrgEngine picks the
        best fit from the shared catalogue.
      </p>

      <div className="flex flex-wrap items-start gap-4">
        {renderKind("panels", view.panels)}
        {renderKind("inverters", view.inverters)}
        {renderKind("batteries", view.batteries)}
      </div>

      {/* "Other / new" (prompt 5). The drawer's summary is the shared
          component's fixed "Advanced options"; the custom-specs wording lives
          on the first line INSIDE it. Disabled with the dropdowns when the
          catalogue failed: a duplicate comparison against a list that did not
          load is not a comparison, and the new unit could not be shown after. */}
      <OverrideDrawer>
        <div className="flex flex-col gap-3 pt-1">
          <div>
            <p className="text-label text-foreground">
              Other / new — a unit that is not in the catalogue
            </p>
            <p className="mt-0.5 text-caption text-muted-foreground">
              It is saved to your company only, marked unverified, and can be
              chosen above.
            </p>
          </div>

          <div>
            <label className="text-caption text-muted-foreground" htmlFor="custom-kind">
              Kind
            </label>
            <div className="mt-1 w-[160px]">
              <Select
                value={drawerKind}
                onValueChange={(v) => {
                  setDrawerKind(v as EquipmentKind);
                  setDraft({});
                  setCreateError(null);
                  setCreateNotices([]);
                }}
                disabled={readOnly}
              >
                <SelectTrigger id="custom-kind" aria-label="Kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EQUIPMENT_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-3">
            {CUSTOM_EQUIPMENT_FIELDS[drawerKind].map((field) => renderDraftField(field))}
          </div>

          {createError ? (
            <p className="max-w-[420px] text-caption text-destructive">{createError}</p>
          ) : null}
          <NoticeStack items={createNotices} />

          <div className="flex items-center gap-3">
            <Button onClick={createUnit} disabled={creating || readOnly}>
              {creating ? "Adding…" : "Add unit"}
            </Button>
            {form[drawerKind] !== baseline[drawerKind] &&
            extraOptions[drawerKind].some((o) => o.id === form[drawerKind]) ? (
              <span className="text-caption text-muted-foreground">
                Added and selected above — press Save to pin it to this job.
              </span>
            ) : null}
          </div>
        </div>
      </OverrideDrawer>

      <NoticeStack items={notices} />

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
        <Button onClick={save} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {dirty ? (
          <span className="text-caption text-muted-foreground">Unsaved changes</span>
        ) : savedTick ? (
          <span className="text-caption text-muted-foreground">Saved</span>
        ) : view.confirmed ? (
          <span className="text-caption text-muted-foreground">Confirmed</span>
        ) : null}
      </div>
    </div>
  );
}
