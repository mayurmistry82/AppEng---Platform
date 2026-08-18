"use client";

import { Pencil } from "lucide-react";
import { NewJobDialog } from "@/components/jobs/new-job-dialog";
import type { JobEditView } from "@/lib/worksheet";

/**
 * The job bar's pencil (3.3c) — the ONLY interactive element the bar gained.
 * A client component so job-bar.tsx STAYS a server component: the bar renders
 * the view, this island owns the click.
 *
 * It holds no field state of its own; NewJobDialog in edit mode owns all of
 * it, re-initialised from `view` on every open. Same children-as-trigger
 * mechanism the AppRail and the /jobs header already use.
 */
export function JobEditButton({ view }: { view: JobEditView }) {
  return (
    <NewJobDialog mode="edit" job={view}>
      <button
        type="button"
        title="Edit job details"
        className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="sr-only">Edit job details</span>
      </button>
    </NewJobDialog>
  );
}
