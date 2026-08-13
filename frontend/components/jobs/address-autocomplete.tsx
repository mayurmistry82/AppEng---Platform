"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Address autocomplete (checklist 3.2) — an ASSIST, never a gate. The field is
 * always a working plain-text input; suggestions are an overlay on top of it.
 * Any autocomplete failure is swallowed silently and the job stays creatable.
 *
 * BILLING (the reason for the session-token discipline): one UUID per address
 * lookup, sent with every keystroke request AND the final details request,
 * then discarded. With a session token the keystroke requests are free
 * ("Autocomplete Session Usage") and only the single details call bills.
 * A lookup = first keystroke → suggestion selected (details fires, token
 * discarded). The next keystroke after a selection starts a NEW token.
 *
 * Debounced 300ms; nothing shorter than 3 characters is ever sent.
 */

export interface AddressSuggestion {
  place_id: string;
  description: string;
}

export function AddressAutocomplete({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (address: string) => void;
  id?: string;
}) {
  const [suggestions, setSuggestions] = React.useState<AddressSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const sessionToken = React.useRef<string | null>(null);
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = React.useRef(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  // Click outside closes the suggestion list (the input keeps its text).
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function fetchSuggestions(input: string) {
    // One token per lookup — created at the first keystroke of the lookup,
    // reused for every subsequent keystroke until a selection discards it.
    sessionToken.current = sessionToken.current ?? crypto.randomUUID();
    const seq = ++requestSeq.current;
    fetch("/api/address/autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, session_token: sessionToken.current }),
    })
      .then((res) => (res.ok ? res.json() : { suggestions: [] }))
      .then((data: { suggestions?: AddressSuggestion[] }) => {
        if (seq !== requestSeq.current) return; // a newer keystroke superseded us
        const list = Array.isArray(data.suggestions) ? data.suggestions : [];
        setSuggestions(list);
        setOpen(list.length > 0);
        setActiveIndex(-1);
      })
      .catch(() => {
        // Silent degradation — plain text keeps working, no visible error.
        if (seq === requestSeq.current) {
          setSuggestions([]);
          setOpen(false);
        }
      });
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    onChange(text);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (text.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceTimer.current = setTimeout(() => fetchSuggestions(text.trim()), 300);
  }

  function select(suggestion: AddressSuggestion) {
    // Fill immediately with the suggestion text, then refine with the ONE
    // details call — which carries the same token and closes the session.
    onChange(suggestion.description);
    setOpen(false);
    setSuggestions([]);
    const token = sessionToken.current;
    sessionToken.current = null; // discard — the next lookup mints a new one
    if (!token) return;
    fetch("/api/address/details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place_id: suggestion.place_id, session_token: token }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { formatted_address?: string | null } | null) => {
        if (data?.formatted_address) onChange(data.formatted_address);
      })
      .catch(() => {
        // The description text already sits in the field — good enough.
      });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0) {
        e.preventDefault();
        select(suggestions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      // Close the list only — stop Radix Dialog from closing on the same key.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id={id}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Start typing an address…"
        className="pl-9"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? "address-suggestions" : undefined}
      />
      {open ? (
        <ul
          id="address-suggestions"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-elev-2"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.place_id} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()} // keep input focus
                onClick={() => select(suggestion)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`block w-full px-3 py-1.5 text-left text-body ${
                  index === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground"
                }`}
              >
                {suggestion.description}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
