"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_FILTER_ID,
  DEFAULT_SORT_ID,
  FILTERS,
  SORTS,
  resolveFilter,
  resolveSort,
} from "@/lib/jobs";

/**
 * Filter bar + debounced search for the /jobs tracker (checklist 3.1).
 *
 * ALL state lives in the URL (?filter=&q=&sort=) — never in React state beyond
 * the input's in-flight text, never in the zustand store. Writes go through
 * router.replace({ scroll: false }); unknown filter/sort values in the URL are
 * resolved to All / updated_desc here, so the backend only ever sees values it
 * accepts (it 422s on anything else).
 *
 * Filter → status params: All → none · In progress → draft & sized & sent ·
 * Won → won · Lost → lost. A job with status `installed` therefore appears
 * only under All — the wireframe's four-tab design, deliberate for 3.1.
 *
 * There is no page/offset param yet, so "changing filter or sort resets to the
 * first page" holds trivially: neither write ever emits an offset.
 */

function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const write = React.useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return { searchParams, write };
}

/** Search input for the header row — ~320px, debounced 300ms into ?q=. */
export function JobSearchInput() {
  const { searchParams, write } = useUrlState();
  const urlQ = searchParams.get("q") ?? "";
  const [text, setText] = React.useState(urlQ);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // A back/forward navigation changes ?q= under us — resync the input.
  React.useEffect(() => {
    setText(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      write({ q: value.trim() || null });
    }, 300);
  }

  return (
    <div className="relative w-full max-w-[320px]">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        value={text}
        onChange={onChange}
        placeholder="Search customer / address…"
        className="pl-9"
        aria-label="Search jobs by customer or address"
      />
    </div>
  );
}

export function JobFilterBar({ total }: { total: number }) {
  const { searchParams, write } = useUrlState();
  const activeFilter = resolveFilter(searchParams.get("filter")).id;
  const activeSort = resolveSort(searchParams.get("sort"));

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1" role="tablist" aria-label="Filter jobs">
        {FILTERS.map((filter) => {
          const active = filter.id === activeFilter;
          return (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() =>
                write({
                  filter: filter.id === DEFAULT_FILTER_ID ? null : filter.id,
                })
              }
              className={`rounded-md px-3 py-1.5 text-body transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                active
                  ? "bg-brand-amber/10 text-brand-amber"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap text-caption text-muted-foreground">
          {total} {total === 1 ? "job" : "jobs"} · sort:
        </span>
        <Select
          value={activeSort}
          onValueChange={(value) =>
            write({ sort: value === DEFAULT_SORT_ID ? null : value })
          }
        >
          <SelectTrigger className="w-[200px]" aria-label="Sort jobs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((sort) => (
              <SelectItem key={sort.id} value={sort.id}>
                {sort.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
