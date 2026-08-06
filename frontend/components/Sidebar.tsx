"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart2,
  Check,
  ChevronDown,
  ClipboardList,
  Cpu,
  DollarSign,
  FileText,
  FolderInput,
  Gift,
  LayoutDashboard,
  MapPin,
  Moon,
  Network,
  Receipt,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useDashboardStore } from "@/lib/store";

interface ChildItem {
  label: string;
  href: string;
  icon?: LucideIcon;
}

interface SimpleItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  children?: undefined;
}

interface GroupItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  children: ChildItem[];
  href?: undefined;
}

type NavItem = SimpleItem | GroupItem;

const NAV_ITEMS: NavItem[] = [
  {
    id: "workflow",
    label: "Workflow",
    icon: LayoutDashboard,
    children: [
      { label: "How it works", href: "/dashboard/workflow/how-it-works" },
      { label: "Stage 1 · Load Characterisation", href: "/dashboard/workflow/stage-1" },
      { label: "Stage 2 · Solar Resource", href: "/dashboard/workflow/stage-2" },
      { label: "Stage 3 · Roof Geometry", href: "/dashboard/workflow/stage-3" },
      { label: "Stage 4 · System Design", href: "/dashboard/workflow/stage-4" },
      { label: "Stage 5 · Generation Simulation", href: "/dashboard/workflow/stage-5" },
      { label: "Stage 6 · Co-Optimisation", href: "/dashboard/workflow/stage-6" },
      { label: "Stage 7 · Financial Model", href: "/dashboard/workflow/stage-7" },
      { label: "Stage 8 · Report Output", href: "/dashboard/workflow/stage-8" },
    ],
  },
  {
    id: "inputs",
    label: "Customer Input",
    icon: FolderInput,
    children: [
      {
        label: "Site Information",
        href: "/dashboard/inputs/site",
        icon: MapPin,
      },
      {
        label: "Bill Upload",
        href: "/dashboard/inputs/bill",
        icon: Receipt,
      },
      {
        label: "Load Survey",
        href: "/dashboard/inputs/survey",
        icon: ClipboardList,
      },
    ],
  },
  {
    id: "outputs",
    label: "Outputs",
    icon: BarChart2,
    children: [
      {
        label: "Energy Usage",
        href: "/dashboard/outputs/energy-usage",
        icon: Zap,
      },
      {
        label: "Load Profile",
        href: "/dashboard/outputs/load-profile",
        icon: Activity,
      },
      {
        label: "Solar Resource",
        href: "/dashboard/outputs/solar",
        icon: Sun,
      },
      {
        label: "System Sizing",
        href: "/dashboard/outputs/sizing",
        icon: Cpu,
      },
      {
        label: "Financial",
        href: "/dashboard/outputs/financial",
        icon: DollarSign,
      },
      {
        label: "Network & Tariff",
        href: "/dashboard/outputs/network",
        icon: Network,
      },
      {
        label: "Incentives",
        href: "/dashboard/outputs/incentives",
        icon: Gift,
      },
    ],
  },
  {
    id: "report",
    label: "Report",
    href: "/dashboard/report",
    icon: FileText,
  },
];

interface SidebarProps {
  userEmail: string;
  signOutAction: () => Promise<void>;
}

export default function Sidebar({ userEmail, signOutAction }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const sidebarOpen = useDashboardStore((s) => s.sidebarOpen);
  const chartMode = useDashboardStore((s) => s.chartMode);
  const setChartMode = useDashboardStore((s) => s.setChartMode);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  const avatarLetter = userEmail ? userEmail[0].toUpperCase() : "?";

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const item of NAV_ITEMS) {
      if (item.children && item.children.some((c) => pathname.startsWith(c.href))) {
        initial.add(item.id);
      }
    }
    return initial;
  });

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      for (const item of NAV_ITEMS) {
        if (
          item.children &&
          item.children.some((c) => pathname.startsWith(c.href))
        ) {
          next.add(item.id);
        }
      }
      return next;
    });
  }, [pathname]);

  return (
    <aside
      className={`flex h-full flex-shrink-0 flex-col border-r border-white/10 bg-enrg-dark2 transition-all duration-200 ${
        sidebarOpen ? "w-60" : "w-16"
      }`}
    >
      {/* Section A: Logo */}
      <div
        className={`flex h-11 flex-shrink-0 items-center border-b border-white/10 ${
          sidebarOpen ? "justify-center gap-2.5 px-4" : "justify-center px-0"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.webp"
          alt="ENRG ENGINE"
          style={{ height: "28px", width: "auto", flexShrink: 0 }}
        />
        {sidebarOpen && (
          <span className="whitespace-nowrap font-syne text-sm font-extrabold tracking-tight text-foreground">
            ENRG ENGINE
          </span>
        )}
      </div>

      {/* Section B: Nav (scrollable) */}
      <div className="flex-1 overflow-y-auto">
        <nav className="py-3">
          {NAV_ITEMS.map((item) => {
            if (!item.children) {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`mx-1 flex items-center gap-3 rounded-r-md px-4 py-2.5 transition ${
                    active
                      ? "border-l-2 border-enrg-amber bg-enrg-amber/10 pl-[14px] text-enrg-amber"
                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                  }`}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {sidebarOpen && (
                    <span className="text-sm font-medium">{item.label}</span>
                  )}
                </Link>
              );
            }

            const groupActive = item.children.some((c) =>
              pathname.startsWith(c.href),
            );
            const isExpanded = expandedGroups.has(item.id);

            return (
              <div key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!sidebarOpen) {
                      router.push(item.children![0].href);
                      return;
                    }
                    setExpandedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    });
                  }}
                  className={`mx-1 flex w-full items-center gap-3 rounded-r-md px-4 py-2.5 transition ${
                    groupActive
                      ? "text-enrg-amber"
                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                  }`}
                >
                  {item.icon && (
                    <item.icon className="h-4 w-4 shrink-0" />
                  )}
                  {sidebarOpen && (
                    <>
                      <span className="flex-1 text-left text-sm font-medium">
                        {item.label}
                      </span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform duration-200 ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </>
                  )}
                </button>

                {sidebarOpen && isExpanded && (
                  <div className="ml-7 mt-0.5 space-y-0.5 border-l border-white/10 pb-1 pl-3">
                    {item.children.map((child) => {
                      const childActive = pathname.startsWith(child.href);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                            childActive
                              ? "text-enrg-amber"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {child.icon && (
                            <child.icon className="h-3 w-3 shrink-0" />
                          )}
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Section C: User tile with popover menu */}
      <div
        ref={menuRef}
        className="relative flex-shrink-0 border-t border-white/10"
      >
        {menuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-lg border border-white/10 bg-enrg-dark2 shadow-xl">
            <div className="border-b border-white/[0.06] px-3 py-2.5">
              <p className="truncate text-xs text-muted-foreground">
                {userEmail}
              </p>
            </div>

            <div className="border-b border-white/[0.06] px-1 py-1">
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Chart theme
              </p>
              <button
                type="button"
                onClick={() => setChartMode("light")}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground transition hover:bg-white/5"
              >
                <Sun className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 text-left text-xs">Light</span>
                {chartMode === "light" && (
                  <Check className="h-3 w-3 text-enrg-amber" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setChartMode("dark")}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground transition hover:bg-white/5"
              >
                <Moon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 text-left text-xs">Dark</span>
                {chartMode === "dark" && (
                  <Check className="h-3 w-3 text-enrg-amber" />
                )}
              </button>
            </div>

            <div className="px-1 py-1">
              <form action={signOutAction} className="w-full">
                <button
                  type="submit"
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className={`flex w-full items-center gap-2.5 px-3 py-3 transition hover:bg-white/5 ${
            menuOpen ? "bg-white/5" : ""
          }`}
        >
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-enrg-amber/20 text-xs font-semibold text-enrg-amber">
            {avatarLetter}
          </div>
          {sidebarOpen && (
            <p className="flex-1 truncate text-left text-xs text-muted-foreground">
              {userEmail}
            </p>
          )}
        </button>
      </div>
    </aside>
  );
}
