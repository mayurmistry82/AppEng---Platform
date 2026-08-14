import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * PhaseRail — DESIGN.md `components: phase-rail`.
 *
 * Vertical, 26px column. Four 20px circular nodes for Site · Demand ·
 * Optimise · Resolve.
 *
 * GLYPH RULE (DESIGN.md `glyph-rule`, decided 2026-08-12, option A): a node
 * shows its LETTER (S/D/O/R) while pending or current; a DONE node replaces
 * its letter with a tick. A fresh job reads S D O R; a finished one reads
 * ✓ ✓ ✓ ✓. Glyphs are NOT fixed per phase — done-vs-pending must never be
 * colour-only (fails for roughly 1 in 12 men), and a brand-new job with no
 * address must not show Site as already ticked.
 *
 *   pending  `border-strong` border, `background` fill, `muted-foreground` letter
 *   done     filled `foreground`, tick in `background`
 *   current  2px `brand-amber` border, `brand-amber` letter — SANCTIONED AMBER
 *            USE #4. Done nodes stay neutral so done and current never read alike.
 *
 * CONNECTOR RULE (DESIGN.md `connector-done.rule`, corrected 2026-08-12): the
 * connector BELOW a done node is filled — progress runs DOWNWARD from each
 * completed node to wherever you currently are.
 *
 * An unrecognised per-node state falls back to "pending" (neutral, letter
 * shown) rather than throwing.
 */

export type PhaseNodeState = "pending" | "current" | "done";

const TICK = "✓";

const PHASES = [
  { letter: "S", label: "Site" },
  { letter: "D", label: "Demand" },
  { letter: "O", label: "Optimise" },
  { letter: "R", label: "Resolve" },
] as const;

function isPhaseNodeState(v: unknown): v is PhaseNodeState {
  return v === "pending" || v === "current" || v === "done";
}

function resolveStates(
  states: readonly [PhaseNodeState, PhaseNodeState, PhaseNodeState, PhaseNodeState],
) {
  return states.map((s) => (isPhaseNodeState(s) ? s : "pending")) as PhaseNodeState[];
}

function Node({ letter, label, state }: { letter: string; label: string; state: PhaseNodeState }) {
  // Only "done" shows the tick — pending and current always show the letter,
  // so completion is never signalled by colour alone.
  const glyph = state === "done" ? TICK : letter;
  return (
    <span
      title={label}
      aria-label={`${label} — ${state}`}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-caption font-bold",
        state === "done" && "border-foreground bg-foreground text-background",
        state === "current" && "border-brand-amber bg-background text-brand-amber",
        state === "pending" && "border-border-strong bg-background text-muted-foreground",
      )}
    >
      {glyph}
    </span>
  );
}

function Connector({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("min-h-[34px] w-0.5 flex-1", done ? "bg-foreground" : "bg-border")}
    />
  );
}

/**
 * ADDITIVE (3.3a fix 5) — the pieces, for callers that lay the four phases out
 * themselves instead of as one compact column. The worksheet body needs each
 * node beside its own group heading, with the connector running down past that
 * group's sections; PhaseRail and PhaseRailWithLabels below are unchanged and
 * still render the compact column on /style-guide.
 *
 * These wrap the SAME Node and Connector the rails use — the markup has one
 * definition and is never duplicated by a caller.
 */
export const PHASE_META = PHASES;

/** One rail node, addressed by its index in PHASE_META (0=Site … 3=Resolve). */
export function PhaseNode({
  index,
  state,
}: {
  index: number;
  state: PhaseNodeState;
}) {
  const phase = PHASES[index] ?? PHASES[0];
  return <Node letter={phase.letter} label={phase.label} state={state} />;
}

/** The vertical run beneath a node; fills a flex-column parent. */
export function PhaseConnector({ done }: { done: boolean }) {
  return <Connector done={done} />;
}

export interface PhaseRailProps {
  /** States for [Site, Demand, Optimise, Resolve], in that order. */
  states: readonly [PhaseNodeState, PhaseNodeState, PhaseNodeState, PhaseNodeState];
  className?: string;
}

/** Nodes + connectors only, no labels — a 26px-wide column. */
export function PhaseRail({ states, className }: PhaseRailProps) {
  const resolved = resolveStates(states);
  return (
    <div className={cn("flex w-[26px] flex-col items-center pt-1", className)}>
      {PHASES.map((phase, i) => (
        <React.Fragment key={phase.label}>
          <Node letter={phase.letter} label={phase.label} state={resolved[i]} />
          {i < PHASES.length - 1 ? (
            // Connector BELOW a done node is filled — progress runs downward.
            <Connector done={resolved[i] === "done"} />
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * PhaseRail plus the Site/Demand/Optimise/Resolve overline labels beside each
 * node. Uses a 2-column CSS grid (rail | label) with the connector on its own
 * grid row, so each label sits in the SAME row as its node and lines up
 * exactly regardless of connector height — no manual margin arithmetic.
 */
export function PhaseRailWithLabels({ states, className }: PhaseRailProps) {
  const resolved = resolveStates(states);
  return (
    <div className={cn("grid grid-cols-[26px_1fr] items-center gap-x-3", className)}>
      {PHASES.map((phase, i) => (
        <React.Fragment key={phase.label}>
          <div className="flex justify-center">
            <Node letter={phase.letter} label={phase.label} state={resolved[i]} />
          </div>
          <span className="text-overline text-muted-foreground">{phase.label}</span>
          {i < PHASES.length - 1 ? (
            <>
              <div className="flex justify-center">
                {/* Connector BELOW a done node is filled — progress runs downward. */}
                <Connector done={resolved[i] === "done"} />
              </div>
              <div />
            </>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}
