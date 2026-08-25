"use client";

import * as React from "react";
import {
  PHASE_META,
  PhaseConnector,
  PhaseNode,
  type PhaseNodeState,
} from "@/components/ui/phase-rail";
import { WorksheetSection } from "@/components/ui/worksheet-section";
import { AddressRoofSection } from "@/components/worksheet/address-roof-section";
import { BatterySizingSection } from "@/components/worksheet/battery-sizing-section";
import { EnergyDataSection } from "@/components/worksheet/energy-data-section";
import { EquipmentSpecsSection } from "@/components/worksheet/equipment-specs-section";
import { IncentivesSection } from "@/components/worksheet/incentives-section";
import { ObjectiveBudgetSection } from "@/components/worksheet/objective-budget-section";
import { ResultsBar } from "@/components/worksheet/results-bar";
import { ResultsSection } from "@/components/worksheet/results-section";
import { SiteDetailsSection } from "@/components/worksheet/site-details-section";
import { SolarSizingSection } from "@/components/worksheet/solar-sizing-section";
import { TariffNetworkSection } from "@/components/worksheet/tariff-network-section";
import {
  groupSectionsByPhase,
  type AddressRoofView,
  type BatterySizingView,
  type EnergyDataView,
  type EquipmentSpecsView,
  type IncentivesView,
  type ObjectiveBudgetView,
  type RailBaseline,
  type ResultsBarView,
  type ResultsView,
  type ScoreCurveView,
  type SizingInputChange,
  type SizingInputSave,
  type RoofDiagramView,
  type SiteDetailsView,
  type SolarSizingView,
  type TariffNetworkView,
  type WorksheetSectionUnlockState,
} from "@/lib/worksheet";

/**
 * Worksheet body (checklist 3.3, regrouped at 3.3a) — the toolbar, the phase
 * groups and the eleven section shells. Open/closed is plain local React state
 * (no store, nothing persisted): the active section opens by default,
 * everything else closed.
 *
 * PHASE GROUPS (3.3a fix 5) — the wireframe carries BOTH the vertical rail and
 * a `.phaselabel` heading above each group. Before 3.3a all four nodes were
 * bunched in one compact column at the top left, so you could not see where
 * Site ended and Demand began. Now each group renders its heading beside its
 * own node, with the connector running down past that group's sections to the
 * next node.
 *
 * Group membership comes from each section's `phase`, split by
 * groupSectionsByPhase in lib/worksheet.ts — never re-derived here. That helper
 * also guarantees a section with an unrecognised phase joins the nearest known
 * group rather than vanishing.
 *
 * The Collapse all / Expand all toolbar stays INSIDE the scrolling region.
 * The wireframe puts it outside; it is a rarely-used control and lifting it out
 * would restructure the page for little gain — deliberate deviation, 2026-08-13.
 *
 * The four unlock states render as:
 *   locked    WorksheetSection state="locked" — collapsed, not expandable,
 *             out of the tab order (the component renders no <summary>)
 *   active    WorksheetSection state="active" (amber), controlled open
 *   complete  WorksheetSection state="complete", controlled open
 *   unlocked  the jumped-pass case — expandable and incomplete. The ui
 *             component's three states cannot express it ("complete" would lie
 *             about progress, and worksheet-section.tsx is frozen), so it
 *             renders here as a plain <details> matching the section shell with
 *             the NEUTRAL empty tick. Unreachable for the four real draft jobs;
 *             revisited at 3.3b.
 *
 * 3.14 prompt 6 (D37): THE BODY HOSTS THE RESULTS BAR, so the smallest thing
 * that lets a section tell the rail "I saved, and here is what kind of change
 * it was" is one piece of React state here and one optional `onSaved` prop
 * on each announcing section. No context, no store, no fingerprinting of the
 * job's data (that would be a second implementation of what the engine reads
 * — 2R.1). The bar renders first, exactly where page.tsx used to render it,
 * so nothing on the worksheet moves.
 */

export interface WorksheetBodySection {
  id: string;
  title: string;
  builtAt: string;
  phase: string;
  state: WorksheetSectionUnlockState;
}

export function WorksheetBody({
  sections,
  phases,
  addressRoof,
  siteDetails,
  roofDiagram,
  energyData,
  tariffNetwork,
  objectiveBudget,
  equipmentSpecs,
  solarSizing,
  batterySizing,
  results,
  incentives,
  jobId,
  resultsBar,
}: {
  sections: readonly WorksheetBodySection[];
  phases: readonly [PhaseNodeState, PhaseNodeState, PhaseNodeState, PhaseNodeState];
  /** 3.4-B: the serialisable Address & roof view; with it, that ONE section
      renders the real body instead of its placeholder. */
  addressRoof?: AddressRoofView;
  /** 3.4b: the Site details view. Its showsMultiDwellingCaution flag is ALSO
      handed to the Address & roof section — one derivation, two renderers (F99). */
  siteDetails?: SiteDetailsView;
  /** 3.5 prompt 2: Google's indicative panel layout — pass-through only. */
  roofDiagram?: RoofDiagramView;
  /** 3.6 prompt 2: the Energy data section's stored-state view. */
  energyData?: EnergyDataView;
  /** 3.8: the Tariff & network view — the stored row over the nem defaults. */
  tariffNetwork?: TariffNetworkView;
  /** 3.9: the Objective & budget view — the three jobs columns, no new fetch. */
  objectiveBudget?: ObjectiveBudgetView;
  /** 3.10: the Equipment & specs view — the job's four equipment columns
      against the company-scoped catalogue. */
  equipmentSpecs?: EquipmentSpecsView;
  /** 3.11: the Solar sizing view — path mode, pinnability, stored result. */
  solarSizing?: SolarSizingView;
  /** 3.12: the Battery sizing view — path battery mode and the stored result.
      Derived from the job the page already has; no new fetch. */
  batterySizing?: BatterySizingView;
  /** 3.13 prompt 3: the Results view — the current run, its financial row,
      the roof's doubt and the panels' direction. NOTE: this section GATES —
      once it completes, Incentives and Summary & finish unlock behind it. */
  results?: ResultsView;
  /** 3.13b: the Incentives view — the stored deductions, their validity
      windows and the CEC fact. Read-only: the section computes nothing,
      stores nothing and takes no jobId, so this prop is the whole wiring. */
  incentives?: IncentivesView;
  jobId?: string;
  /** 3.14 prompt 6: the results bar's stored view, curve and rail baseline.
      Optional — without it the body renders no bar, exactly as before. */
  resultsBar?: {
    view: ResultsBarView;
    curve: ScoreCurveView;
    baseline: RailBaseline;
  };
}) {
  // The announcement: set by an announcing section on a persisted save, read
  // by the bar. `seq` makes a repeated identical save announce again.
  const [change, setChange] = React.useState<SizingInputChange | null>(null);
  const seq = React.useRef(0);
  const announce = React.useCallback(
    (section: string) => (save: SizingInputSave) => {
      seq.current += 1;
      setChange({ ...save, section, seq: seq.current });
    },
    [],
  );

  const [openIds, setOpenIds] = React.useState<Record<string, boolean>>(() => {
    const active = sections.find((s) => s.state === "active");
    return active ? { [active.id]: true } : {};
  });

  function setOpen(id: string, open: boolean) {
    setOpenIds((prev) => ({ ...prev, [id]: open }));
  }
  function collapseAll() {
    setOpenIds({});
  }
  function expandAll() {
    // Every UNLOCKED section opens; locked ones stay shut (they cannot open).
    const next: Record<string, boolean> = {};
    for (const s of sections) {
      if (s.state !== "locked") next[s.id] = true;
    }
    setOpenIds(next);
  }

  const groups = groupSectionsByPhase(sections);

  const toolbarButton =
    "rounded-md border border-border px-2.5 py-1 text-caption text-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  function renderSection(section: WorksheetBodySection) {
    const body =
      section.id === "address-roof" && addressRoof && jobId ? (
        // isOpen gates the billable tile <img>: a closed <details> keeps its
        // children in the DOM, so the image must not exist until the section
        // is actually open.
        <AddressRoofSection
          view={addressRoof}
          jobId={jobId}
          isOpen={!!openIds[section.id]}
          showsMultiDwellingCaution={siteDetails?.showsMultiDwellingCaution ?? false}
          diagram={roofDiagram}
          onSaved={announce(section.id)}
        />
      ) : section.id === "site-details" && siteDetails && jobId ? (
        <SiteDetailsSection view={siteDetails} jobId={jobId} onSaved={announce(section.id)} />
      ) : section.id === "energy-data" && energyData && jobId ? (
        <EnergyDataSection view={energyData} jobId={jobId} onSaved={announce(section.id)} />
      ) : section.id === "tariff-network" && tariffNetwork && jobId ? (
        <TariffNetworkSection view={tariffNetwork} jobId={jobId} onSaved={announce(section.id)} />
      ) : section.id === "objective-budget" && objectiveBudget && jobId ? (
        <ObjectiveBudgetSection view={objectiveBudget} jobId={jobId} onSaved={announce(section.id)} />
      ) : section.id === "equipment-specs" && equipmentSpecs && jobId ? (
        <EquipmentSpecsSection view={equipmentSpecs} jobId={jobId} onSaved={announce(section.id)} />
      ) : section.id === "solar-sizing" && solarSizing && jobId ? (
        <SolarSizingSection view={solarSizing} jobId={jobId} />
      ) : section.id === "battery-sizing" && batterySizing && jobId ? (
        <BatterySizingSection view={batterySizing} jobId={jobId} />
      ) : section.id === "results" && results && jobId ? (
        <ResultsSection view={results} jobId={jobId} />
      ) : section.id === "incentives" && incentives ? (
        <IncentivesSection view={incentives} />
      ) : (
        <p className="text-caption text-muted-foreground">
          Built at {section.builtAt}
        </p>
      );
    if (section.state === "unlocked") {
      // Jumped-pass case — see the header comment.
      return (
        <details
          key={section.id}
          open={!!openIds[section.id]}
          onToggle={(e) => {
            if (e.target === e.currentTarget) {
              setOpen(section.id, e.currentTarget.open);
            }
          }}
          className="rounded-lg border border-border bg-card"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-h3 text-foreground [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-border-strong"
            />
            <span>{section.title}</span>
          </summary>
          <div className="border-t border-border p-3">{body}</div>
        </details>
      );
    }
    return (
      <WorksheetSection
        key={section.id}
        title={section.title}
        state={section.state}
        open={section.state === "locked" ? undefined : !!openIds[section.id]}
        onOpenChange={
          section.state === "locked"
            ? undefined
            : (open) => setOpen(section.id, open)
        }
      >
        {body}
      </WorksheetSection>
    );
  }

  return (
    <>
      {/* 3.14 prompt 6: the bar, first — the same position page.tsx gave it. */}
      {resultsBar ? (
        <ResultsBar
          view={resultsBar.view}
          jobId={jobId}
          curve={resultsBar.curve}
          baseline={resultsBar.baseline}
          change={change}
        />
      ) : null}
    <div className="mt-3">
      {/* Toolbar — wireframe `.wtoolbar` */}
      <div className="flex items-center gap-2">
        <span className="text-label text-muted-foreground">Sections:</span>
        <button type="button" onClick={collapseAll} className={toolbarButton}>
          Collapse all
        </button>
        <button type="button" onClick={expandAll} className={toolbarButton}>
          Expand all
        </button>
        <span className="text-caption text-muted-foreground">
          — mostly collapsed by default, less scrolling
        </span>
      </div>

      {/* Four phase groups: [node | heading] then [connector | sections]. */}
      <div className="mt-3 grid grid-cols-[26px_1fr] gap-x-4">
        {groups.map((group, index) => {
          const last = index === groups.length - 1;
          return (
            <React.Fragment key={group.phase}>
              <div className="flex justify-center py-1.5">
                <PhaseNode index={index} state={phases[index]} />
              </div>
              <div className="flex items-center py-1.5">
                <span className="text-overline text-muted-foreground">
                  {PHASE_META[index]?.label ?? group.phase}
                </span>
              </div>

              <div className="flex flex-col items-center">
                {/* Connector runs beside this group's sections to the next
                    node; the final group has nothing below it to reach. */}
                {last ? null : <PhaseConnector done={phases[index] === "done"} />}
              </div>
              <div className="flex min-w-0 flex-col gap-2 pb-4">
                {group.sections.map(renderSection)}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
    </>
  );
}
