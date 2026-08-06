"use client";

import { useEffect, useState } from "react";
import {
  useDashboardStore,
  type CustomerInputs,
  type Occupancy,
} from "@/lib/store";

// Public privacy notice the installer presents to the customer. TODO: point at the
// canonical hosted notice URL once published (placeholder route for now).
const PRIVACY_NOTICE_URL = "/privacy-notice";

const OCCUPANCY_OPTIONS: { value: Occupancy; label: string }[] = [
  { value: "home_day", label: "Home during day" },
  { value: "away_day", label: "Away during day" },
  { value: "business", label: "Business" },
];

export default function CustomerSitePanel() {
  const saved = useDashboardStore((s) => s.customerInputs);
  const setCustomerInputs = useDashboardStore((s) => s.setCustomerInputs);
  const storeAddress = useDashboardStore(
    (s) => s.customerInputs.propertyAddress,
  );
  const storeCustomerName = useDashboardStore(
    (s) => s.customerInputs.customerName,
  );

  // Installer attestation (read by assembleJobPayload) — an installer action, not part
  // of the customer form. Toggling updates the store immediately so the next save picks
  // it up. This is NOT an end-customer consent checkbox; it confirms the installer gave
  // the customer EnrgEngine's privacy notice.
  const privacyNoticeGiven = useDashboardStore((s) => s.privacyNoticeGiven);
  const setPrivacyNoticeGiven = useDashboardStore((s) => s.setPrivacyNoticeGiven);

  const [form, setForm] = useState<CustomerInputs>(saved);
  const [addressError, setAddressError] = useState(false);

  // Sync form when store address or customer name updates externally (e.g. BillPanel).
  useEffect(() => {
    const { propertyAddress, customerName } =
      useDashboardStore.getState().customerInputs;
    if (propertyAddress || customerName) {
      setForm((prev) => ({
        ...prev,
        propertyAddress: propertyAddress || prev.propertyAddress,
        customerName: customerName || prev.customerName,
      }));
    }
  }, [storeAddress, storeCustomerName]);

  function update<K extends keyof CustomerInputs>(
    key: K,
    value: CustomerInputs[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSave() {
    if (!form.propertyAddress.trim()) {
      setAddressError(true);
      return;
    }
    setAddressError(false);
    setCustomerInputs(form);
  }

  return (
    <div>
      <div className="px-6 pb-4">
        <h2 className="text-sm font-semibold text-foreground">
          Customer &amp; Site
        </h2>
      </div>

      {/* Section 1: Customer */}
      <div className="grid grid-cols-1 gap-10 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
        <div className="md:col-span-1">
          <h3 className="text-sm font-semibold text-foreground">Customer</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The property owner receiving this report.
          </p>
        </div>
        <div className="md:col-span-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Customer name">
              <input
                type="text"
                value={form.customerName}
                onChange={(e) => update("customerName", e.target.value)}
                autoComplete="name"
                className={inputCls}
              />
            </Field>

            <Field label="Property address" required>
              <input
                type="text"
                value={form.propertyAddress}
                onChange={(e) => {
                  update("propertyAddress", e.target.value);
                  if (addressError && e.target.value.trim()) {
                    setAddressError(false);
                  }
                }}
                autoComplete="street-address"
                className={`${inputCls} ${addressError ? "border-enrg-amber" : ""}`}
              />
              {addressError && (
                <p className="mt-1 text-xs text-enrg-amber">
                  Property address is required
                </p>
              )}
            </Field>
          </div>
        </div>
      </div>

      {/* Section 2: Project parameters */}
      <div className="grid grid-cols-1 gap-10 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
        <div className="md:col-span-1">
          <h3 className="text-sm font-semibold text-foreground">
            Project parameters
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Used to size the system correctly.
          </p>
        </div>
        <div className="md:col-span-2 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Budget (optional)">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="e.g. 15000"
                  value={form.budget ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    update("budget", v === "" ? null : Number(v));
                  }}
                  className={`${inputCls} pl-7 pr-12`}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  AUD
                </span>
              </div>
            </Field>

            <Field label="Battery storage">
              <div className="flex gap-2">
                <ToggleOption
                  selected={form.wantsBattery}
                  onClick={() => update("wantsBattery", true)}
                  label="Yes"
                />
                <ToggleOption
                  selected={!form.wantsBattery}
                  onClick={() => update("wantsBattery", false)}
                  label="No"
                />
              </div>
            </Field>
          </div>

          <Field label="Occupancy">
            <select
              value={form.occupancy}
              onChange={(e) =>
                update("occupancy", e.target.value as Occupancy)
              }
              className={`${inputCls} appearance-none`}
            >
              {OCCUPANCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {/* Section 3: Data & privacy — installer attestation (notice-based, not customer consent) */}
      <div className="grid grid-cols-1 gap-10 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
        <div className="md:col-span-1">
          <h3 className="text-sm font-semibold text-foreground">
            Data &amp; privacy
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A quick confirmation from you, the installer.
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="flex cursor-pointer items-start gap-3">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                privacyNoticeGiven
                  ? "border-enrg-amber bg-enrg-amber"
                  : "border-white/20 bg-transparent"
              }`}
            >
              {privacyNoticeGiven && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="h-3 w-3 text-enrg-dark"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m4.5 12.75 6 6 9-13.5"
                  />
                </svg>
              )}
            </span>
            <input
              type="checkbox"
              checked={privacyNoticeGiven ?? false}
              onChange={(e) => setPrivacyNoticeGiven(e.target.checked)}
              className="sr-only"
              aria-label="I confirm the customer has been given EnrgEngine's privacy notice"
            />
            <span>
              <span className="block text-sm text-foreground">
                I confirm the customer has been given EnrgEngine&apos;s{" "}
                <a
                  href={PRIVACY_NOTICE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-enrg-amber underline underline-offset-2 hover:opacity-80"
                >
                  privacy notice
                </a>
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Only de-identified technical data is used to improve sizing accuracy —
                never customer names, addresses, or contact details.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* Action row */}
      <div className="border-t border-white/[0.06] px-6 py-4">
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md bg-enrg-gradient px-4 py-2 text-sm font-medium text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-white/[0.15] bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors focus:border-enrg-amber focus:outline-none";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-enrg-amber">*</span>}
      </label>
      {children}
    </div>
  );
}

function ToggleOption({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition ${
        selected
          ? "border-enrg-amber bg-enrg-amber text-enrg-dark"
          : "border-white/10 bg-white/5 text-foreground hover:border-enrg-amber/40"
      }`}
    >
      {label}
    </button>
  );
}
