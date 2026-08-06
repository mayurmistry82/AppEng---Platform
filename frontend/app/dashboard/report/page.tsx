"use client";

import { useMemo, useState } from "react";
import { generateReport } from "@/lib/api";
import { useDashboardStore } from "@/lib/store";

interface PanelDef {
  id: string;
  label: string;
  premium: boolean;
}

const REPORT_PANELS: PanelDef[] = [
  { id: "bill_summary", label: "Bill Summary", premium: false },
  { id: "load_profile", label: "Load Profile", premium: false },
  { id: "solar_resource", label: "Solar Resource", premium: false },
  { id: "roof_geometry", label: "Roof Geometry", premium: false },
  { id: "system_sizing", label: "System Sizing", premium: false },
  { id: "financial_outcomes", label: "Financial Outcomes", premium: false },
  { id: "network_constraints", label: "Network Constraints", premium: false },
  { id: "government_incentives", label: "Government Incentives", premium: false },
];

const PANEL_BY_ID: Record<string, PanelDef> = Object.fromEntries(
  REPORT_PANELS.map((p) => [p.id, p]),
);

export default function ReportPage() {
  const billData = useDashboardStore((s) => s.billData);
  const loadData = useDashboardStore((s) => s.loadData);

  const [order, setOrder] = useState<string[]>(() =>
    REPORT_PANELS.map((p) => p.id),
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () =>
      new Set(REPORT_PANELS.filter((p) => !p.premium).map((p) => p.id)),
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [installerName, setInstallerName] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);

  const orderedSelected = useMemo(
    () => order.filter((id) => selectedIds.has(id)),
    [order, selectedIds],
  );

  function toggleSelected(id: string) {
    const def = PANEL_BY_ID[id];
    if (!def || def.premium) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveSelected(id: string, direction: -1 | 1) {
    setOrder((prev) => {
      const orderedSelectedNow = prev.filter((x) => selectedIds.has(x));
      const idx = orderedSelectedNow.indexOf(id);
      const swapWith = orderedSelectedNow[idx + direction];
      if (idx === -1 || !swapWith) return prev;

      const next = prev.slice();
      const a = next.indexOf(id);
      const b = next.indexOf(swapWith);
      next[a] = swapWith;
      next[b] = id;
      return next;
    });
  }

  async function handleGenerate() {
    if (orderedSelected.length === 0) return;
    setIsGenerating(true);
    setErrorMsg("");
    try {
      const blob = await generateReport({
        selected_panels: orderedSelected,
        bill_data: billData as Record<string, unknown> | null,
        load_profile: loadData as Record<string, unknown> | null,
        customer_name: customerName,
        installer_name: installerName,
        installer_company: "",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "EnrgEngine-Report.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      console.error("[ReportBuilder] generate failed:", err);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Failed to generate report. Please try again.",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  function panelHasData(id: string): boolean {
    if (id === "bill_summary") return billData !== null;
    if (id === "load_profile") return loadData !== null;
    return false;
  }

  const canGenerate = orderedSelected.length > 0 && !isGenerating;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-syne text-2xl font-extrabold tracking-tight text-foreground">
          Report Builder
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Select and order the panels to include in your customer report.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* LEFT: Panel selector + Report settings */}
        <div>
          <h2 className="mb-4 font-syne text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Panels
          </h2>
          <ul className="space-y-1">
            {order.map((id) => {
              const def = PANEL_BY_ID[id];
              if (!def) return null;
              const checked = selectedIds.has(id);
              const orderedSel = order.filter((x) => selectedIds.has(x));
              const positionInSel = orderedSel.indexOf(id);
              const isTop = positionInSel === 0;
              const isBottom = positionInSel === orderedSel.length - 1;

              return (
                <li
                  key={id}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelected(id)}
                    disabled={def.premium}
                    className={`h-4 w-4 accent-enrg-amber ${
                      def.premium
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer"
                    }`}
                  />
                  <span
                    className={`flex-1 text-sm ${
                      def.premium
                        ? "text-muted-foreground opacity-50"
                        : "text-foreground"
                    }`}
                  >
                    {def.label}
                  </span>
                  {def.premium && (
                    <>
                      <span aria-hidden="true" className="text-muted-foreground">
                        🔒
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        Subscribers only
                      </span>
                    </>
                  )}
                  {!def.premium && checked && (
                    <div className="flex items-center gap-1">
                      <ArrowBtn
                        direction="up"
                        onClick={() => moveSelected(id, -1)}
                        invisible={isTop}
                      />
                      <ArrowBtn
                        direction="down"
                        onClick={() => moveSelected(id, 1)}
                        invisible={isBottom}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="my-6 border-t border-white/10" />

          <h2 className="mb-4 font-syne text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Report Settings
          </h2>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Customer name on report
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Enter customer name"
                className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-enrg-amber focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Installer logo
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={(e) =>
                  setLogoFile(e.target.files?.[0] ?? null)
                }
                className="block w-full text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-enrg-amber file:px-3 file:py-2 file:font-syne file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-enrg-dark hover:file:bg-enrg-orange"
              />
              {logoFile && (
                <p className="mt-1 text-xs text-foreground/70">{logoFile.name}</p>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: Preview */}
        <div>
          <h2 className="mb-4 font-syne text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Preview
          </h2>

          {orderedSelected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Select panels to preview your report.
            </p>
          ) : (
            <div className="space-y-2">
              {orderedSelected.map((id) => {
                const def = PANEL_BY_ID[id];
                if (!def) return null;
                const ready = panelHasData(id);
                return (
                  <div
                    key={id}
                    className="border-b border-white/[0.06] py-4"
                  >
                    <div className="font-syne text-sm font-bold text-foreground">
                      {def.label}
                    </div>
                    <div className="mt-1 flex items-center text-xs text-muted-foreground">
                      <span
                        className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                          ready ? "bg-green-500" : "bg-enrg-amber"
                        }`}
                      />
                      {ready ? "Ready" : "Awaiting analysis"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          className={`w-full rounded-md py-3 font-syne text-sm font-bold uppercase tracking-wider transition-all ${
            canGenerate
              ? "bg-enrg-gradient text-enrg-dark hover:opacity-90 hover:-translate-y-px active:translate-y-0"
              : "cursor-not-allowed bg-enrg-gradient text-enrg-dark opacity-50"
          }`}
        >
          {isGenerating ? "Generating…" : "Generate Report"}
        </button>
        {errorMsg && (
          <p className="mt-2 text-sm text-red-400">{errorMsg}</p>
        )}
      </div>
    </div>
  );
}

function ArrowBtn({
  direction,
  onClick,
  invisible,
}: {
  direction: "up" | "down";
  onClick: () => void;
  invisible: boolean;
}) {
  if (invisible) {
    // Reserve the same space so rows don't jump when arrows hide.
    return <span className="inline-block h-6 w-6" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "up" ? "Move up" : "Move down"}
      className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
    >
      {direction === "up" ? "▲" : "▼"}
    </button>
  );
}
