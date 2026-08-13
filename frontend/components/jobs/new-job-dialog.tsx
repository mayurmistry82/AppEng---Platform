"use client";

import * as React from "react";
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
import {
  DISABLED_PATH_REASON,
  sizingOptions,
  type JobIntent,
} from "@/lib/jobs";

/**
 * New Job modal (checklist 3.2) — wraps any trigger via `children`; the same
 * component serves the AppRail button, the /jobs header button and the empty
 * state. No global state.
 *
 * CLOSE BEHAVIOUR (chosen and documented): Escape / overlay / Cancel KEEP the
 * typed state for the next open — nothing is discarded until the job is
 * actually created. Losing a typed address is the worst outcome here, and a
 * confirm prompt on every stray Escape would be worse than remembering.
 *
 * Sizing options come from sizingOptions() — the single source of truth. When
 * "Has solar" is chosen, C and D render VISIBLE and DISABLED with the D1
 * reason beneath, and exactly ONE option (F) is selectable. That is intended
 * until 4.1 — do not "fix" it here.
 */

interface CreateResponse {
  job_id?: string;
  flags?: string[];
  detail?: unknown;
}

/** "" → null, non-numeric → null — never 0, never a throw. */
function parseKw(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function NewJobDialog({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  // Field state lives OUTSIDE DialogContent so closing keeps it (see above).
  const [address, setAddress] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [hasSolar, setHasSolar] = React.useState<boolean | null>(null);
  const [solarKw, setSolarKw] = React.useState("");
  const [inverterKw, setInverterKw] = React.useState("");
  const [intent, setIntent] = React.useState<JobIntent | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const options = sizingOptions(hasSolar);
  const canSubmit = address.trim().length > 0 && intent !== null && !submitting;

  function chooseHasSolar(value: boolean) {
    setHasSolar(value);
    // The current intent may not exist / be enabled under the new answer.
    const stillValid = sizingOptions(value).some(
      (o) => o.intent === intent && o.enabled,
    );
    if (!stillValid) setIntent(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true); // double-submit guard — one job per click
    setError(null);
    try {
      const res = await fetch("/api/job/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // NEVER path / company_id / installer_id — path is a GENERATED column
        // and identity comes from the token.
        body: JSON.stringify({
          address: address.trim(),
          customer_name: customerName.trim() || null,
          has_existing_solar: hasSolar,
          existing_solar_kw: hasSolar ? parseKw(solarKw) : null,
          existing_inverter_kw: hasSolar ? parseKw(inverterKw) : null,
          intent,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as CreateResponse;

      if (res.status === 401 || res.status === 403) {
        setError("Your session may have expired — sign in again.");
        return;
      }
      if (!res.ok || !data.job_id) {
        setError(
          "The job could not be created — the backend reported an error. Your entries are kept; try again.",
        );
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
    } catch {
      setError(
        "Could not reach the server — check the backend is running on port 8000. Your entries are kept.",
      );
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            A job starts with the address (fires roof + irradiance) and the job
            type (sets which of the six paths runs).
          </DialogDescription>
        </DialogHeader>

        <div className="mt-5 flex flex-col gap-5">
          {/* 1 — address, the anchor. Autocomplete is an assist; free text always works. */}
          <div>
            <label htmlFor="new-job-address" className="text-label text-foreground">
              Property address{" "}
              <span className="text-caption text-muted-foreground">
                — required, the anchor
              </span>
            </label>
            <div className="mt-1.5">
              <AddressAutocomplete
                id="new-job-address"
                value={address}
                onChange={setAddress}
              />
            </div>
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

          {/* 4 — sizing options; hidden entirely until step 3 is answered */}
          {options.length > 0 ? (
            <div>
              <span className="text-label text-foreground">What are we sizing?</span>
              <div className="mt-1.5 flex flex-col gap-2" role="radiogroup" aria-label="What are we sizing?">
                {options.map((option) => {
                  const selected = intent === option.intent && option.enabled;
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
            <p role="alert" className="text-body text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="justify-between">
          <p className="text-caption text-muted-foreground">
            Job type is shown and editable later in the worksheet.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {submitting ? "Creating…" : "Create and open worksheet ›"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
