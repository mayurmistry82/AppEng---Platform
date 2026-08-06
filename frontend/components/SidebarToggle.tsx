"use client";

import { PanelLeft } from "lucide-react";
import { useDashboardStore } from "@/lib/store";

export default function SidebarToggle() {
  const sidebarOpen = useDashboardStore((s) => s.sidebarOpen);
  const setSidebarOpen = useDashboardStore((s) => s.setSidebarOpen);

  return (
    <button
      type="button"
      onClick={() => setSidebarOpen(!sidebarOpen)}
      aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      className="p-2 text-muted-foreground transition hover:text-enrg-amber"
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}
