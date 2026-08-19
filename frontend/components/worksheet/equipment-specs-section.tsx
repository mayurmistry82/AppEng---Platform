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
import {
  equipmentSaveNotices,
  type EquipmentKindView,
  type EquipmentSpecsView,
  type RoofNoticeView,
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
}: {
  view: EquipmentSpecsView;
  jobId: string;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => fromView(view));
  const [saving, setSaving] = React.useState(false);
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);
  const [saveNotices, setSaveNotices] = React.useState<readonly RoofNoticeView[]>([]);
  const [savedTick, setSavedTick] = React.useState(false);

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
      router.refresh();
    } finally {
      setSaving(false);
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

  function renderKind(kind: keyof FormState, kindView: EquipmentKindView) {
    const value = form[kind] === "" ? AUTO_VALUE : form[kind];
    // A stored id that is not in the visible list is offered as its own
    // option so the Select shows the real choice rather than snapping to
    // Auto — the view keeps it, and so does the control.
    const missing =
      form[kind] !== "" && !kindView.options.some((o) => o.id === form[kind]);
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
              {kindView.options.map((option) => (
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
