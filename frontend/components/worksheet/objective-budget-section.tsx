"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { NoticeStack } from "@/components/ui/notice-stack";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { requestJson } from "@/lib/client-api";
import { clientActionErrorCopy, type ApiErrorKind } from "@/lib/jobs";
import {
  OBJECTIVE_BOUNDS,
  OBJECTIVE_OPTIONS,
  objectiveSaveNotices,
  type ObjectiveBudgetView,
  type RoofNoticeView,
  type SizingInputSave,
} from "@/lib/worksheet";

/**
 * Objective & budget (checklist 3.9) — what the engine optimises FOR: the
 * objective, the optional NPV-vs-self-sufficiency blend, the optional spend
 * cap. Saved through PATCH /api/job/{id} (the ONE job-field writer), read back
 * from the same row, and reflected in the section's completeness so the phase
 * rail moves past it.
 *
 * THE SAVE PAYLOAD RULES, and the middle one is the easy one to get wrong:
 *   - objective: sent whenever it changed. Never an objective nobody chose.
 *   - custom_weight: sent ONLY when the chosen objective is "custom". Anything
 *     else leaves the key ABSENT — the engine only reads the weight in its
 *     objective == "custom" branch, so a stale stored blend is harmless, and
 *     clearing it would throw away a blend the installer set earlier the
 *     moment they toggle away and back.
 *   - budget_aud: a number when the field has content, an EXPLICIT NULL when
 *     cleared, absent when untouched.
 *
 * PATCH returns the updated row, not a { saved } envelope, so
 * objectiveSaveNotices IS the round-trip check: a 200 whose row disagrees with
 * what was sent must never read as saved (the 3.6 lesson).
 */

/** 409/422/503 carry a plain-English `detail` written for exactly this. */
function saveErrorCopy(kind: ApiErrorKind, status: number, message: string) {
  if (kind === "http" && message && (status === 409 || status === 422 || status === 503)) {
    return { heading: "That didn't save", body: message };
  }
  return clientActionErrorCopy(kind, status);
}

interface FormState {
  objective: string; // "" = nothing chosen
  weight: number; // slider value, always a number — 0.5 when nothing stored
  budget: string; // Input text — "" = no cap
}

function fromView(view: ObjectiveBudgetView): FormState {
  return {
    objective: view.objective ?? "",
    weight: view.customWeight.raw ?? 0.5,
    budget: view.budgetAud.text,
  };
}

export function ObjectiveBudgetSection({
  view,
  jobId,
  onSaved,
}: {
  view: ObjectiveBudgetView;
  jobId: string;
  /** 3.14 prompt 6 (D37): called after a PERSISTED save so the results rail
      can answer "what did that change do". Optional — absent means silent,
      and the rail keeps showing the stored run. */
  onSaved?: (change: SizingInputSave) => void;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => fromView(view));
  const [saving, setSaving] = React.useState(false);
  const [budgetError, setBudgetError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);
  const [saveNotices, setSaveNotices] = React.useState<readonly RoofNoticeView[]>([]);
  const [savedTick, setSavedTick] = React.useState(false);

  const baseline = React.useMemo(() => fromView(view), [view]);
  const dirty =
    form.objective !== baseline.objective ||
    form.weight !== baseline.weight ||
    form.budget !== baseline.budget;

  function touch() {
    setSavedTick(false);
    setSaveNotices([]);
  }

  // A stored objective outside the list is offered as "(as stored)" — the
  // same behaviour site-details gives an off-list roof material. Never
  // silently reset a stored value.
  const options: { value: string; label: string }[] = [...OBJECTIVE_OPTIONS];
  if (form.objective && !options.some((o) => o.value === form.objective)) {
    options.push({ value: form.objective, label: `${form.objective} (as stored)` });
  }

  function validate(): boolean {
    const text = form.budget.trim();
    if (text === "") {
      setBudgetError(null);
      return true; // empty is a real answer: no cap
    }
    const value = Number(text);
    const bound = OBJECTIVE_BOUNDS.budgetAud;
    if (!Number.isFinite(value) || value <= bound.min || value > bound.max) {
      setBudgetError(bound.message);
      return false;
    }
    setBudgetError(null);
    return true;
  }

  async function save() {
    if (saving || !dirty) return;
    if (!validate()) return; // never submit a knowingly invalid body
    setSaving(true);
    setActionError(null);
    setSaveNotices([]);
    try {
      const payload: Record<string, unknown> = {};
      if (form.objective && form.objective !== baseline.objective) {
        payload.objective = form.objective;
      }
      if (form.objective === "custom") {
        payload.custom_weight = form.weight;
      }
      if (form.budget !== baseline.budget) {
        const text = form.budget.trim();
        payload.budget_aud = text === "" ? null : Number(text);
      }
      if (Object.keys(payload).length === 0) return;
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
      const notices = objectiveSaveNotices(payload, result.data);
      if (notices.length > 0) {
        // A 200 whose row disagrees with what was sent is NOT a save.
        setSaveNotices(notices);
        return;
      }
      setSavedTick(true);
      // 3.14 prompt 6: the INSTANT path — the values now stored, so the rail
      // re-ranks the run's stored options with no request at all (D37).
      onSaved?.({
        kind: "objective-budget",
        objective: form.objective || baseline.objective || null,
        customWeight: form.objective === "custom" ? form.weight : null,
        budgetAud: form.budget.trim() === "" ? null : Number(form.budget),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  // Save-attempt notices first, then the view's own — deduped by title,
  // NoticeStack does the D25 ordering.
  const notices: RoofNoticeView[] = [];
  const seen = new Set<string>();
  for (const notice of [...saveNotices, ...view.notices]) {
    if (seen.has(notice.title)) continue;
    seen.add(notice.title);
    notices.push(notice);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        What the engine optimises for. A budget cap is optional — leaving it
        empty means no cap, which is a real answer.
      </p>

      <div>
        <label className="text-caption text-muted-foreground" htmlFor="objective-select">
          Objective
        </label>
        <div className="mt-1 w-[200px]">
          <Select
            value={form.objective}
            onValueChange={(v) => {
              setForm((f) => ({ ...f, objective: v }));
              touch();
            }}
          >
            <SelectTrigger id="objective-select" aria-label="Objective">
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

      {/* The slider exists ONLY for a custom blend — absent from the DOM
          otherwise, never hidden with CSS (the C&I tariff-rows rule). */}
      {form.objective === "custom" ? (
        <div className="max-w-[360px]">
          <label className="text-caption text-muted-foreground" htmlFor="objective-blend">
            Blend
          </label>
          <div className="mt-2 flex items-center gap-3">
            <Slider
              id="objective-blend"
              value={[form.weight]}
              onValueChange={([v]) => {
                setForm((f) => ({ ...f, weight: v }));
                touch();
              }}
              min={OBJECTIVE_BOUNDS.customWeight.min}
              max={OBJECTIVE_BOUNDS.customWeight.max}
              step={0.05}
              aria-label="Blend between self-sufficiency and financial return"
            />
            <span className="w-[44px] text-body text-foreground tabular-nums">
              {form.weight.toFixed(2)}
            </span>
          </div>
          {/* The two ends labelled, so the number means something without a
              tooltip: 0 is all self-sufficiency, 1 is all financial return. */}
          <div className="mt-1 flex justify-between text-caption text-muted-foreground">
            <span>Self-sufficiency</span>
            <span>Financial return</span>
          </div>
        </div>
      ) : null}

      <div>
        <label className="text-caption text-muted-foreground" htmlFor="objective-budget-cap">
          Budget cap (optional)
        </label>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-body text-muted-foreground">$</span>
          <Input
            id="objective-budget-cap"
            className="w-[130px]"
            type="number"
            inputMode="numeric"
            step="100"
            placeholder="e.g. 20000"
            value={form.budget}
            onChange={(e) => {
              setForm((f) => ({ ...f, budget: e.target.value }));
              setBudgetError(null);
              touch();
            }}
          />
        </div>
        {budgetError ? (
          <p className="mt-1 max-w-[320px] text-caption text-destructive">{budgetError}</p>
        ) : (
          <p className="mt-1 text-caption text-muted-foreground">
            Leave empty for no cap.
          </p>
        )}
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
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
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
