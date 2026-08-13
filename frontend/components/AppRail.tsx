"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CircleUser,
  History,
  LayoutDashboard,
  Package,
  Plus,
} from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import { NewJobDialog } from "@/components/jobs/new-job-dialog";

/**
 * Left icon rail (Stage 2.2) — layout from docs/2026-08-04-dashboard-newjob-wireframe.html.
 * 84px wide, icon-above-label items. Semantic tokens ONLY — no legacy utility
 * colours, no raw values (they break in light mode; the old Sidebar is not a
 * reference here).
 *
 * BORDER RULE (F33): in dark mode `accent` / `sidebar-accent` / `sidebar-border`
 * share one value, so a hairline vanishes into its own hover fill. Edges that must
 * survive hover — the rail's edge, the popover edge — bind to `border`.
 *
 * Active nav = amber (sanctioned: DESIGN.md — amber is the brand highlight for
 * active nav / accuracy meter / selected states). Primary actions = blue.
 */

interface AppRailProps {
  userEmail: string;
  signOutAction: () => Promise<void>;
}

const NAV_ITEMS = [
  { href: "/jobs", label: "Dashboard", icon: LayoutDashboard },
  { href: "/equipment", label: "Equipment", icon: Package },
] as const;

export default function AppRail({ userEmail, signOutAction }: AppRailProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside closes the Account popover (same behaviour as the old
  // Sidebar's user menu, rebound to semantic tokens).
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  const itemBase =
    "flex w-full flex-col items-center gap-1 rounded-md py-2 transition";
  const itemIdle =
    "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
  const itemActive = "bg-brand-amber/10 text-brand-amber";

  return (
    <aside className="flex h-full w-[84px] flex-shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar px-2 py-3 text-sidebar-foreground">
      {/* Logo */}
      <Link href="/jobs" className="mb-2 flex h-10 items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.webp" alt="ENRG ENGINE" className="h-7 w-auto" />
      </Link>

      {/* Dashboard */}
      {NAV_ITEMS.slice(0, 1).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${itemBase} ${active ? itemActive : itemIdle}`}
          >
            <item.icon className="h-5 w-5" />
            <span className="text-caption">{item.label}</span>
          </Link>
        );
      })}

      {/* New job — PRIMARY action, so blue, never amber. Opens the 3.2
          creation modal (same NewJobDialog as the /jobs header + empty state). */}
      <NewJobDialog>
        <button
          type="button"
          className="flex w-full flex-col items-center gap-1 rounded-md bg-primary py-2 text-primary-foreground transition hover:bg-primary-hover active:bg-primary-active"
        >
          <Plus className="h-5 w-5" />
          <span className="text-caption">New job</span>
        </button>
      </NewJobDialog>

      {/* Equipment */}
      {NAV_ITEMS.slice(1).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${itemBase} ${active ? itemActive : itemIdle}`}
          >
            <item.icon className="h-5 w-5" />
            <span className="text-caption">{item.label}</span>
          </Link>
        );
      })}

      <div className="flex-1" />

      {/* Standalone theme control — never hidden in a menu. */}
      <ThemeToggle />

      {/* Legacy — TEMPORARY, remove at 3.16. Exists only because "/" now lands
          on /jobs, whose pages are empty until Stage 3; the working /dashboard
          app must stay one click away. Deliberately de-emphasised: muted, and
          never shows the amber active treatment. */}
      <Link
        href="/dashboard"
        className={`${itemBase} text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground`}
      >
        <History className="h-5 w-5" />
        <span className="text-caption">Legacy</span>
      </Link>

      {/* Account — pinned bottom; popover with email + sign out. No theme
          control in here — that lives in the rail now. */}
      <div ref={menuRef} className="relative w-full">
        {menuOpen && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-elev-2">
            <div className="border-b border-border px-3 py-2.5">
              <p className="truncate text-caption text-muted-foreground">
                {userEmail}
              </p>
            </div>
            <div className="px-1 py-1">
              <Link
                href="/account"
                onClick={() => setMenuOpen(false)}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-body text-popover-foreground transition hover:bg-accent hover:text-accent-foreground"
              >
                Account
              </Link>
              <form action={signOutAction} className="w-full">
                <button
                  type="submit"
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-body text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
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
          className={`${itemBase} ${
            pathname.startsWith("/account")
              ? itemActive
              : menuOpen
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : itemIdle
          }`}
        >
          <CircleUser className="h-5 w-5" />
          <span className="text-caption">Account</span>
        </button>
      </div>
    </aside>
  );
}
