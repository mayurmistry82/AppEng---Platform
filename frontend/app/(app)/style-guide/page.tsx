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

      <Section title="Hover help" note="Opens on hover AND on keyboard focus — Tab to the ? below.">
        <div className="flex items-center gap-2">
          <span className="text-body text-foreground">Accuracy tier</span>
          <HoverHelp label="What is the accuracy tier?">
            Tier 3 uses your real interval data. Tier 2 uses a bill. Tier 1 falls
            back to a load survey.
          </HoverHelp>
        </div>
      </Section>
    </div>
  );
}
