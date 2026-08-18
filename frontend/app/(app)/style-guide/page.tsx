"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { StatusPill, type JobStatus } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HoverHelp } from "@/components/ui/tooltip";
import { WorksheetSection } from "@/components/ui/worksheet-section";
import {
  OverrideDrawer,
  OverrideDrawerPins,
  OverrideDrawerRow,
  PinChip,
} from "@/components/ui/override-drawer";
import { KpiStrip, KpiTile } from "@/components/ui/kpi-tile";
import { Notice } from "@/components/ui/notice";
import { NoticeCaption } from "@/components/ui/notice-caption";
import { LoadPreviewStrip } from "@/components/worksheet/load-preview-strip";
import { loadPreviewView } from "@/lib/worksheet";
import { AccuracyMeter } from "@/components/ui/accuracy-meter";
import { PhaseRailWithLabels } from "@/components/ui/phase-rail";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  useChartDefaults,
} from "@/components/charts/chart-container";

/**
 * Style guide (Stage 2.3a) — every component, variant and state on one page so
 * both themes can be verified at a glance. Flip the rail's theme toggle and
 * nothing here should become illegible.
 *
 * 3.16 decides whether this stays as a living style guide or is deleted. It sits
 * inside the (app) group deliberately: it inherits the rail and the auth guard.
 */

const STATUSES: JobStatus[] = ["draft", "sized", "sent", "won", "lost"];

const ROWS = [
  { customer: "A. Nguyen", site: "Kensington SA 5068", status: "won" as const, kw: "6.60" },
  { customer: "B. Okafor", site: "Brighton SA 5048", status: "sized" as const, kw: "8.80" },
  { customer: "C. Rossi", site: "Adelaide SA 5000", status: "sent" as const, kw: "10.56" },
  { customer: "D. Patel", site: "Glenelg SA 5045", status: "draft" as const, kw: "—" },
  { customer: "E. Sørensen", site: "Unley SA 5061", status: "lost" as const, kw: "5.28" },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-h2 text-foreground">{title}</h2>
        {note ? (
          <p className="mt-1 text-caption text-muted-foreground">{note}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export default function StyleGuidePage() {
  const [sliderA, setSliderA] = useState([0]);
  const [sliderB, setSliderB] = useState([50]);
  const [sliderC, setSliderC] = useState([100]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-8 py-10">
      <header>
        <h1 className="text-h1 text-foreground">Style guide</h1>
        <p className="mt-2 text-body text-muted-foreground">
          The eight standard components — built at 2.3a. Toggle the theme in the
          rail to check both modes.
        </p>
      </header>

      <Section
        title="Button"
        note="Primary · secondary (neutral, never amber) · ghost · danger (white on red). Tab to each for the focus ring."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete job</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="sm">Primary sm</Button>
          <Button variant="secondary" size="sm">Secondary sm</Button>
          <Button variant="ghost" size="sm">Ghost sm</Button>
          <Button variant="danger" size="sm">Danger sm</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled>Primary disabled</Button>
          <Button variant="secondary" disabled>Secondary disabled</Button>
          <Button variant="ghost" disabled>Ghost disabled</Button>
          <Button variant="danger" disabled>Danger disabled</Button>
        </div>
        <p className="text-caption text-muted-foreground">
          Hover and active states are live — press and hold a button to see the
          active ramp.
        </p>
      </Section>

      <Section title="Input" note="Normal · placeholder · focused (click in) · disabled.">
        <div className="grid max-w-md gap-3">
          <Input defaultValue="14 Frome St, Adelaide SA 5000" aria-label="Address" />
          <Input placeholder="Placeholder — customer name" aria-label="Customer name" />
          <Input defaultValue="Disabled field" disabled aria-label="Disabled" />
        </div>
      </Section>

      <Section title="Select" note="Closed and open. Open it and arrow through — highlighted item uses accent.">
        <div className="grid max-w-md gap-3">
          <Select defaultValue="both">
            <SelectTrigger aria-label="Job intent">
              <SelectValue placeholder="Select intent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="solar">Solar only</SelectItem>
              <SelectItem value="battery">Battery only</SelectItem>
              <SelectSeparator />
              <SelectItem value="both">Solar + battery</SelectItem>
            </SelectContent>
          </Select>
          <Select>
            <SelectTrigger aria-label="Objective">
              <SelectValue placeholder="Placeholder — choose an objective" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="max_npv">Maximise NPV</SelectItem>
              <SelectItem value="min_payback">Minimise payback</SelectItem>
              <SelectItem value="disabled" disabled>
                Custom weights (disabled)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Slider" note="At 0, 50 and 100. Tab to a thumb and use the arrow keys.">
        <div className="grid max-w-md gap-6">
          <div className="space-y-2">
            <p className="text-label text-muted-foreground">Value {sliderA[0]}</p>
            <Slider value={sliderA} onValueChange={setSliderA} max={100} step={1} aria-label="Slider at zero" />
          </div>
          <div className="space-y-2">
            <p className="text-label text-muted-foreground">Value {sliderB[0]}</p>
            <Slider value={sliderB} onValueChange={setSliderB} max={100} step={1} aria-label="Slider at fifty" />
          </div>
          <div className="space-y-2">
            <p className="text-label text-muted-foreground">Value {sliderC[0]}</p>
            <Slider value={sliderC} onValueChange={setSliderC} max={100} step={1} aria-label="Slider at one hundred" />
          </div>
        </div>
      </Section>

      <Section title="Card" note="card surface, border, rounded lg, elev-1, 20px padding.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-h3">Recommended system</CardTitle>
              <CardDescription className="text-caption">
                Optimised for maximum NPV
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="metric-lg text-foreground">10.56 kW</p>
              <p className="mt-1 text-caption text-muted-foreground">
                24 panels across 2 planes
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-h3">Payback</CardTitle>
              <CardDescription className="text-caption">
                Including STC, excluding finance
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="metric-lg text-foreground">4.8 yrs</p>
              <p className="mt-1 text-caption text-muted-foreground">
                Net cost $7,248
              </p>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Table" note="36px rows. Hover a row — the divider must stay visible (F33).">
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">System</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((row) => (
                <TableRow key={row.customer}>
                  <TableCell className="text-foreground">{row.customer}</TableCell>
                  <TableCell className="text-muted-foreground">{row.site}</TableCell>
                  <TableCell>
                    <StatusPill status={row.status} />
                  </TableCell>
                  <TableCell className="metric-sm text-right text-foreground">
                    {row.kw}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Section>

      <Section title="Status pill" note="The five job statuses, plus the unknown-status fallback (renders draft, never throws).">
        <div className="flex flex-wrap items-center gap-3">
          {STATUSES.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
          <StatusPill status="not-a-real-status">Unknown → draft</StatusPill>
        </div>
      </Section>

      <Section title="Notice" note="All four tones (DESIGN.md notice, added 2026-08-14 for 3.4-B). role=note, never alert. Caution is ORANGE (warning), never amber. An unrecognised tone falls back to info.">
        <div className="flex max-w-xl flex-col gap-2">
          <Notice tone="info" title="No aerial photo out here">
            The imagery does not cover this area — entering the roof from plans is the accurate way anyway.
          </Notice>
          <Notice tone="success" title="Roof found">
            Google&apos;s aerial imagery found this roof automatically.
          </Notice>
          <Notice tone="caution" title="The photo is 7 years old">
            Anything built or planted since then will not appear.
          </Notice>
          <Notice tone="problem" title="That didn&apos;t work">
            The lookup hit an error — try again in a moment.
          </Notice>
          <Notice tone="not-a-real-tone" title="Unknown tone → info">
            Falls back to info rather than throwing.
          </Notice>
        </div>
      </Section>

      <Section
        title="Notice caption"
        note="The QUIET fifth level (DESIGN.md notice-caption, added 2026-08-17 for 3.6 under D25). A FACT about how the tool works — no border, no fill, no tone, no bold title. Findings always render above captions. The one question: could this ever NOT fire on a job like this one? No → caption."
      >
        <div className="flex max-w-xl flex-col gap-2">
          <Notice tone="caution" title="One of these faces is too steep to be a roof">
            A finding about THIS job keeps the bordered notice, above every caption.
          </Notice>
          <NoticeCaption icon="clock">
            The photo is 7 years old. Anything built or planted since then will not appear.
          </NoticeCaption>
          <NoticeCaption>
            Solar export channel(s) B1 present — automatically excluded (load profile uses consumption only).
          </NoticeCaption>
        </div>
      </Section>

      <Section
        title="Load preview strip"
        note="3.6 prompt 3 — 24 hand-drawn SVG bars from the profile's own weights, chart tokens only, no chart library (F47). The flat case names NO peak: deriving a peak from Tier 1's [1.0]×24 would be a confident fabrication. aria-label states the shape in words."
      >
        <div className="flex max-w-2xl flex-col gap-6">
          {/* The real average-day weights the shaped fixture produces, with its
              real daily average — so the style guide shows the same chart the
              worksheet does, units and all. */}
          <LoadPreviewStrip
            view={loadPreviewView(
              [
                0.435, 0.404, 0.383, 0.38, 0.401, 0.468, 0.797, 1.206, 1.113,
                0.761, 0.662, 0.649, 0.695, 0.669, 0.708, 0.745, 0.887, 2.188,
                2.44, 2.629, 2.259, 1.559, 0.952, 0.611,
              ],
              15.069,
              3,
            )}
          />
          {/* Tier 1: a flat national archetype — the caption is correct. */}
          <LoadPreviewStrip
            view={loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 1)}
          />
          {/* Tier 3 flat: measured data with no shape is a FINDING, not a
              method fact — never described as a national average (D27.3). */}
          <LoadPreviewStrip
            view={loadPreviewView(Array.from({ length: 24 }, () => 1), 12, 3)}
          />
        </div>
      </Section>

      <Section title="Hover help" note="Opens on hover AND on keyboard focus — Tab to the ? below.">
        <div className="flex items-center gap-2">
          <span className="text-body text-foreground">Accuracy tier</span>
          <HoverHelp label="What is the accuracy tier?">
            Tier 3 uses your real interval data. Tier 2 uses a bill. Tier 1 falls
            back to a load survey.
          </HoverHelp>
        </div>
      </Section>

      {/* ── Platform components (2.3b) ──────────────────────────────────── */}

      <Section
        title="Worksheet section"
        note="Locked (opacity, not expandable) · active (amber border + tick, drawer open below) · complete (neutral filled tick — never amber, so done and current never read alike)."
      >
        <div className="space-y-3">
          <WorksheetSection title="Address & roof" state="locked">
            <p>Unreachable while locked.</p>
          </WorksheetSection>

          <WorksheetSection title="Energy data" state="active" defaultOpen>
            <p className="text-body text-foreground">
              14 Frome St, Adelaide SA 5000 — interval data uploaded (NEM12).
            </p>
            <OverrideDrawer defaultOpen>
              <OverrideDrawerPins>
                <PinChip>8 panels pinned</PinChip>
                <PinChip>Export limit 5 kW</PinChip>
                <PinChip>Reserve SoC 20%</PinChip>
              </OverrideDrawerPins>
              <OverrideDrawerRow label="Panel count" value="8 (unconstrained: 24)" />
              <OverrideDrawerRow label="Export limit" value="5 kW (unconstrained: 10 kW)" />
              <OverrideDrawerRow
                label="Reserve SoC"
                value="20% (unconstrained: 0%)"
                isLast
              />
            </OverrideDrawer>
          </WorksheetSection>

          <WorksheetSection title="Sizing & objective" state="complete">
            <p>10.56 kW · 24 panels across 2 planes.</p>
          </WorksheetSection>
        </div>
      </Section>

      <Section title="KPI tile" note="4-column strip — one positive delta, one negative.">
        <KpiStrip>
          <KpiTile label="Pipeline value" value="$142,800" delta="+$18,200 this month" deltaSign="positive" />
          <KpiTile label="Win rate (90d)" value="62%" delta="+4 pts" deltaSign="positive" />
          <KpiTile label="In progress" value="14" delta="No change" />
          <KpiTile label="Avg payback" value="5.2 yrs" delta="+0.3 yrs" deltaSign="negative" />
        </KpiStrip>
      </Section>

      <Section
        title="Accuracy meter"
        note="Tier 1 (33.3%), Tier 2 (66.6%), Tier 3 (100%) side by side. An invalid tier renders an empty track — try it via the fourth example."
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,190px))] items-start gap-6">
          <AccuracyMeter tier={1} />
          <AccuracyMeter tier={2} />
          <AccuracyMeter tier={3} />
          <AccuracyMeter tier={undefined} />
        </div>
      </Section>

      <Section
        title="Phase rail"
        note="Nodes show their letter (S D O R); a done node shows a tick instead, so this reads ✓ D O R and a finished job reads ✓ ✓ ✓ ✓ — done is neutral, current is amber, and the connector below a done node fills to carry progress down to Demand."
      >
        <PhaseRailWithLabels states={["done", "current", "pending", "pending"]} />
      </Section>

      <Section
        title="Charts"
        note="recharts is the standard for every new chart — colours come from the CSS chart tokens, so flipping the theme recolours them with no reload. Plotly is reserved for exactly two heavy technical charts (the 8,760-hour series and the 7×24 heatmap) and is lazily loaded, so it is deliberately not shown here."
      >
        <ChartSample />
      </Section>
    </div>
  );
}

/** Sample recharts chart: three series, grid, axes, tooltip, dashed A/B baseline. */
function ChartSample() {
  const d = useChartDefaults();

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <ChartContainer height={280}>
        <LineChart data={CHART_SAMPLE_DATA} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...d.grid} />
          <XAxis dataKey="month" {...d.axis} />
          <YAxis {...d.axis} width={44} />
          <Tooltip {...d.tooltip} />
          <Legend
            wrapperStyle={{ fontSize: 12, color: d.tokens["chart-axis"] }}
            iconType="plainline"
          />
          {/* Dashed baseline — the A/B comparison overlay, the one sanctioned dashed line. */}
          <ReferenceLine y={520} {...d.baseline} label={{
            value: "Baseline",
            position: "insideTopRight",
            fill: d.tokens["chart-axis"],
            fontSize: 11,
          }} />
          <Line name="Solar generation" dataKey="generation" stroke={d.byRole.solarGeneration} {...d.line} />
          <Line name="Grid import" dataKey="gridImport" stroke={d.byRole.gridImport} {...d.line} />
          <Line name="Export" dataKey="exported" stroke={d.byRole.export} {...d.line} />
        </LineChart>
      </ChartContainer>
    </div>
  );
}

const CHART_SAMPLE_DATA = [
  { month: "Jul", generation: 410, gridImport: 620, exported: 150 },
  { month: "Aug", generation: 480, gridImport: 560, exported: 190 },
  { month: "Sep", generation: 640, gridImport: 430, exported: 280 },
  { month: "Oct", generation: 780, gridImport: 340, exported: 390 },
  { month: "Nov", generation: 880, gridImport: 300, exported: 470 },
  { month: "Dec", generation: 920, gridImport: 290, exported: 510 },
];
