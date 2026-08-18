"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/jobs/address-autocomplete";
import { postJson, requestJson } from "@/lib/client-api";
import {
  DISABLED_PATH_REASON,
  UNIT_ADDRESS_HINT,
  clientActionErrorCopy,
  jobDialogFooterNote,
  jobEditErrorCopy,
  needsUnitNumberHint,
  sizingOptions,
  type JobIntent,
} from "@/lib/jobs";
import type { JobEditView } from "@/lib/worksheet";

/**
 * New Job modal (checklist 3.2) — and, since 3.3c, the SAME modal in EDIT mode
 * for the worksheet job bar's pencil. Wraps any trigger via `children`. The
 * mode prop is a discriminated union so "edit without a job" and "create with
 * a job" are both unrepresentable.
 *
 * CLOSE BEHAVIOUR differs by mode, deliberately:
 *   create — Escape / overlay / Cancel KEEP the typed state for the next open;
 *            losing a typed address is the worst outcome and a confirm prompt
 *            on every stray Escape would be worse than remembering.
 *   edit   — Escape / overlay / Cancel DISCARD the edits; the next open
 *            re-reads from the job. Keeping stale edits against a record that
 *            exists on the server is how a user later saves a value they
 *            thought they had abandoned.
 *
 * THE ADDRESS IN EDIT MODE (F82, closed): editable only while NOTHING has been
 * derived from it. jobEditView (lib/worksheet.ts) owns that rule; once locked,
 * the autocomplete is replaced by a disabled input with the reason beneath it
 * — and the SERVER enforces the same rule with a 409, because a disabled field
 * is not a security boundary.
 *
 * Sizing options come from sizingOptions() — the single source of truth. When
 * "Has solar" is chosen, C and D render VISIBLE and DISABLED with the D1
 * reason beneath. On INITIAL LOAD in edit mode a stored intent is rendered
 * selected even if its option shows disabled — clearing a stored value the
 * instant a modal opens would be a silent edit. Changing the Has-solar answer
 * still clears an intent that is no longer selectable (unchanged behaviour).
 */

interface CreateResponse {
  job_id?: string;
  flags?: string[];
  detail?: unknown;
}

type NewJobDialogProps = { children: React.ReactNode } & (
  | { mode?: "create" }
  | { mode: "edit"; job: JobEditView }
);

/** "" → null, non-numeric → null — never 0, never a throw. */
function parseKw(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function NewJobDialog(props: NewJobDialogProps) {
  const { children } = props;
  const isEdit = props.mode === "edit";
  const editJob = props.mode === "edit" ? props.job : null;
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  // Field state lives OUTSIDE DialogContent so create mode keeps it on close
  // (see above). Edit mode re-initialises from the job on every OPEN instead.
  const [address, setAddress] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [hasSolar, setHasSolar] = React.useState<boolean | null>(null);
  const [solarKw, setSolarKw] = React.useState("");
  const [inverterKw, setInverterKw] = React.useState("");
  const [intent, setIntent] = React.useState<JobIntent | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<
    { heading: string; body: string; isAuth: boolean } | null
  >(null);

  function handleOpenChange(next: boolean) {
    if (next && editJob) {
      // Re-read from the job on every open, so a refresh after a save is
      // reflected — and so a discarded edit really is discarded.
      setAddress(editJob.address);
      setCustomerName(editJob.customerName);
      setHasSolar(editJob.hasExistingSolar);
      setSolarKw(editJob.existingSolarKw);
      setInverterKw(editJob.existingInverterKw);
      setIntent(editJob.intent);
      setError(null);
    }
    setOpen(next);
  }

  const options = sizingOptions(hasSolar);
  const canSubmit = isEdit
    ? intent !== null && !submitting
    : address.trim().length > 0 && intent !== null && !submitting;

  const addressLocked = isEdit && (editJob?.addressLocked ?? false);
  const showUnitHint = !addressLocked && needsUnitNumberHint(address);

  function chooseHasSolar(value: boolean) {
    setHasSolar(value);
    // The current intent may not exist / be enabled under the new answer.
    const stillValid = sizingOptions(value).some(
      (o) => o.intent === intent && o.enabled,
    );
    if (!stillValid) setIntent(null);
  }

  async function submitCreate() {
    // NEVER path / company_id / installer_id — path is a GENERATED column
    // and identity comes from the token.
    const result = await postJson<CreateResponse>("/api/job/create", {
      address: address.trim(),
      customer_name: customerName.trim() || null,
      has_existing_solar: hasSolar,
      existing_solar_kw: hasSolar ? parseKw(solarKw) : null,
      existing_inverter_kw: hasSolar ? parseKw(inverterKw) : null,
      intent,
    });

    if (!result.ok) {
      // Same vocabulary as the worksheet (3.4-E): an expired session says so
      // plainly and the dialog STAYS OPEN with every value intact.
      const copy = clientActionErrorCopy(result.kind, result.status);
      setError({ ...copy, isAuth: result.kind === "auth" });
      return;
    }
    const data = result.data ?? {};
    if (!data.job_id) {
      setError({
        heading: "The job could not be created",
        body: "The server accepted the request but returned no job. Your entries are kept — try again.",
        isAuth: false,
      });
      return;
    }

    // Surface derivation flags rather than discarding them; the worksheet
    // is the next screen and 3.3+ will render them there.
    if (Array.isArray(data.flags) && data.flags.length > 0) {
      console.warn("Job created with flags:", data.flags);
    }

    // Success — reset for the next job, then open the worksheet.
    setAddress("");
    setCustomerName("");
    setHasSolar(null);
    setSolarKw("");
    setInverterKw("");
    setIntent(null);
    setOpen(false);
    router.push(`/jobs/${data.job_id}/worksheet`);
  }

  async function submitEdit(job: JobEditView) {
    // ONLY CHANGED FIELDS travel — the same dirty-tracking discipline the
    // site-details section uses. An unchanged address is never sent, so the
    // lock can only ever reject a genuine change attempt.
    const payload: Record<string, unknown> = {};
    if (customerName.trim() !== job.customerName.trim()) {
      payload.customer_name = customerName.trim() || null;
    }
    if (hasSolar !== job.hasExistingSolar && hasSolar !== null) {
      payload.has_existing_solar = hasSolar;
    }
    const kwChanged =
      solarKw.trim() !== job.existingSolarKw.trim() ||
      hasSolar !== job.hasExistingSolar;
    if (kwChanged) {
      payload.existing_solar_kw = hasSolar === true ? parseKw(solarKw) : null;
    }
    const invChanged =
      inverterKw.trim() !== job.existingInverterKw.trim() ||
      hasSolar !== job.hasExistingSolar;
    if (invChanged) {
      payload.existing_inverter_kw =
        hasSolar === true ? parseKw(inverterKw) : null;
    }
    if (intent !== job.intent && intent !== null) {
      payload.intent = intent;
    }
    if (
      !job.addressLocked &&
      address.trim() !== "" &&
      address.trim() !== job.address.trim()
    ) {
      payload.address = address.trim();
    }

    if (Object.keys(payload).length === 0) {
      setOpen(false); // nothing changed — no request at all
      return;
    }

    const result = await requestJson<Record<string, unknown>>(
      "PATCH",
      `/api/job/${encodeURIComponent(job.jobId)}`,
      payload,
    );
    if (!result.ok) {
      // A 409 carries the server's specific, true reason (the address lock) —
      // render IT, not generic copy. Everything else uses the shared copy.
      const copy = jobEditErrorCopy(result.kind, result.status, result.message);
      setError({ ...copy, isAuth: result.kind === "auth" });
      return;
    }
    setOpen(false);
    // NO router.push: changing intent re-derives jobs.path and 3.3b renders a
    // different section set — the worksheet must re-render in place.
    router.refresh();
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true); // double-submit guard
    setError(null);
    try {
      if (editJob) {
        await submitEdit(editJob);
      } else {
        await submitCreate();
      }
    } finally {
      setSubmitting(false);
    }
  }

  const segmentBase =
    "rounded-md px-3 py-1.5 text-body transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover";
  const segmentActive = "bg-primary-solid text-primary-foreground";
  const segmentIdle =
    "border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit job" : "New job"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Changing the job type re-derives which sections the worksheet shows."
              : "A job starts with the address (fires roof + irradiance) and the job type (sets which of the six paths runs)."}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-5 flex flex-col gap-5">
          {/* 1 — address, the anchor. Autocomplete is an assist; free text always works. */}
          <div>
            <label htmlFor="new-job-address" className="text-label text-foreground">
              Property address{" "}
              {isEdit ? null : (
                <span className="text-caption text-muted-foreground">
                  — required, the anchor
                </span>
              )}
            </label>
            <div className="mt-1.5">
              {addressLocked ? (
                <Input
                  id="new-job-address"
                  value={address}
                  disabled
                  aria-disabled="true"
                  title={editJob?.addressLockReason ?? undefined}
                />
              ) : (
                <AddressAutocomplete
                  id="new-job-address"
                  value={address}
                  onChange={setAddress}
                />
              )}
            </div>
            {addressLocked && editJob?.addressLockReason ? (
              // Visible-but-disabled, the same D1 treatment paths C and D get.
              <p className="mt-1 text-caption text-muted-foreground">
                {editJob.addressLockReason}
              </p>
            ) : null}
            {showUnitHint ? (
              // F99's caption half: quiet, never a gate, never rewrites input.
              <p className="mt-1 text-caption text-muted-foreground">
                {UNIT_ADDRESS_HINT}
              </p>
            ) : null}
          </div>

          {/* 2 — customer name */}
          <div>
            <label htmlFor="new-job-customer" className="text-label text-foreground">
              Customer name (optional)
            </label>
            <Input
              id="new-job-customer"
              className="mt-1.5"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="e.g. J. Nguyen"
            />
          </div>

          {/* 3 — existing solar; no default */}
          <div>
            <span className="text-label text-foreground">Existing solar on site?</span>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => chooseHasSolar(true)}
                aria-pressed={hasSolar === true}
                className={`${segmentBase} ${hasSolar === true ? segmentActive : segmentIdle}`}
              >
                Has solar
              </button>
              <button
                type="button"
                onClick={() => chooseHasSolar(false)}
                aria-pressed={hasSolar === false}
                className={`${segmentBase} ${hasSolar === false ? segmentActive : segmentIdle}`}
              >
                None
              </button>
            </div>
            {hasSolar === true ? (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-job-solar-kw" className="text-caption text-muted-foreground">
                    Existing solar (kW)
                  </label>
                  <Input
                    id="new-job-solar-kw"
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.1"
                    value={solarKw}
                    onChange={(e) => setSolarKw(e.target.value)}
                    placeholder="e.g. 6.6"
                  />
                </div>
                <div>
                  <label htmlFor="new-job-inverter-kw" className="text-caption text-muted-foreground">
                    Existing inverter (kW)
                  </label>
                  <Input
                    id="new-job-inverter-kw"
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.1"
                    value={inverterKw}
                    onChange={(e) => setInverterKw(e.target.value)}
                    placeholder="e.g. 5.0"
                  />
                </div>
              </div>
            ) : null}
          </div>

          {/* 4 — sizing options; hidden entirely until step 3 is answered.
              Edit mode: a stored intent renders SELECTED even when its option
              shows disabled — clearing it on open would be a silent edit. */}
          {options.length > 0 ? (
            <div>
              <span className="text-label text-foreground">What are we sizing?</span>
              <div className="mt-1.5 flex flex-col gap-2" role="radiogroup" aria-label="What are we sizing?">
                {options.map((option) => {
                  const selected = intent === option.intent;
                  return (
                    <button
                      key={option.path}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-disabled={!option.enabled}
                      onClick={() => {
                        if (option.enabled) setIntent(option.intent);
                      }}
                      className={`${segmentBase} text-left ${
                        selected
                          ? segmentActive
                          : option.enabled
                            ? segmentIdle
                            : "border border-border-subtle text-text-disabled"
                      }`}
                    >
                      {option.label}{" "}
                      <span className={selected ? "" : "text-caption text-muted-foreground"}>
                        ({option.path})
                      </span>
                    </button>
                  );
                })}
              </div>
              {hasSolar === true ? (
                <p className="mt-2 text-caption text-muted-foreground">
                  {DISABLED_PATH_REASON}
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div role="alert" className="text-body text-destructive">
              <p className="font-semibold">{error.heading}</p>
              <p className="text-caption">
                {error.body}
                {error.isAuth ? (
                  <>
                    {" "}
                    <Link href="/login" className="text-primary underline">
                      Go to sign in
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="justify-between">
          <p className="text-caption text-muted-foreground">
            {jobDialogFooterNote(isEdit ? "edit" : "create")}
          </p>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {isEdit
                ? submitting
                  ? "Saving…"
                  : "Save changes"
                : submitting
                  ? "Creating…"
                  : "Create and open worksheet ›"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
