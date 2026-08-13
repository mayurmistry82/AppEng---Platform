import type { Config } from "tailwindcss";

/*
 * EnrgEngine Tailwind theme — Stage 2.1.
 * Every colour resolves through `hsl(var(--x) / <alpha-value>)`, so:
 *   1. opacity modifiers (bg-primary/10) actually work, and
 *   2. an undefined variable fails visibly instead of rendering transparent.
 * The CSS variables live in app/globals.css (:root = light, .dark = dark) and are
 * generated from docs/DESIGN.md — bind to semantic tokens, never to a hex.
 */

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // ── Surfaces ────────────────────────────────────────────────────────
        background: "hsl(var(--background) / <alpha-value>)",
        "bg-subtle": "hsl(var(--bg-subtle) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },

        // ── Text ────────────────────────────────────────────────────────────
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        "text-secondary": "hsl(var(--text-secondary) / <alpha-value>)",
        "text-disabled": "hsl(var(--text-disabled) / <alpha-value>)",

        // ── Interactive accents ─────────────────────────────────────────────
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          hover: "hsl(var(--primary-hover) / <alpha-value>)",
          active: "hsl(var(--primary-active) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
          // Filled-surface ramp (F45) — bg for a white label, e.g. the primary button.
          // `primary` above stays the text/link/ring/border role; do not conflate them.
          solid: {
            DEFAULT: "hsl(var(--primary-solid) / <alpha-value>)",
            hover: "hsl(var(--primary-solid-hover) / <alpha-value>)",
            active: "hsl(var(--primary-solid-active) / <alpha-value>)",
          },
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        ring: "hsl(var(--ring) / <alpha-value>)",

        // ── Brand (brand moments only — never UI chrome) ────────────────────
        brand: {
          amber: {
            DEFAULT: "hsl(var(--brand-amber) / <alpha-value>)",
            hover: "hsl(var(--brand-amber-hover) / <alpha-value>)",
            active: "hsl(var(--brand-amber-active) / <alpha-value>)",
          },
          orange: {
            DEFAULT: "hsl(var(--brand-orange) / <alpha-value>)",
            hover: "hsl(var(--brand-orange-hover) / <alpha-value>)",
            active: "hsl(var(--brand-orange-active) / <alpha-value>)",
          },
          blue: "hsl(var(--brand-blue) / <alpha-value>)",
          "blue-dark": "hsl(var(--brand-blue-dark) / <alpha-value>)",
        },

        // ── Borders ─────────────────────────────────────────────────────────
        border: {
          DEFAULT: "hsl(var(--border) / <alpha-value>)",
          subtle: "hsl(var(--border-subtle) / <alpha-value>)",
          strong: "hsl(var(--border-strong) / <alpha-value>)",
        },
        input: "hsl(var(--input) / <alpha-value>)",

        // ── Semantic states ─────────────────────────────────────────────────
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          // Legacy alias, not in DESIGN.md's 75 — app/login/page.tsx still uses
          // text-destructive-foreground. Dies with that call site at 3.16.
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
          subtle: "hsl(var(--destructive-subtle) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
          foreground: "hsl(var(--success-foreground) / <alpha-value>)",
          subtle: "hsl(var(--success-subtle) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
          subtle: "hsl(var(--warning-subtle) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--info) / <alpha-value>)",
          foreground: "hsl(var(--info-foreground) / <alpha-value>)",
          subtle: "hsl(var(--info-subtle) / <alpha-value>)",
        },

        // ── Sidebar ─────────────────────────────────────────────────────────
        sidebar: {
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          border: "hsl(var(--sidebar-border) / <alpha-value>)",
          ring: "hsl(var(--sidebar-ring) / <alpha-value>)",
          primary: {
            DEFAULT: "hsl(var(--sidebar-primary) / <alpha-value>)",
            foreground: "hsl(var(--sidebar-primary-foreground) / <alpha-value>)",
          },
          accent: {
            DEFAULT: "hsl(var(--sidebar-accent) / <alpha-value>)",
            foreground: "hsl(var(--sidebar-accent-foreground) / <alpha-value>)",
          },
        },

        // ── Job-status pills (dot / bg / fg × 6) ────────────────────────────
        status: {
          draft: {
            DEFAULT: "hsl(var(--status-draft) / <alpha-value>)",
            bg: "hsl(var(--status-draft-bg) / <alpha-value>)",
            foreground: "hsl(var(--status-draft-foreground) / <alpha-value>)",
          },
          sized: {
            DEFAULT: "hsl(var(--status-sized) / <alpha-value>)",
            bg: "hsl(var(--status-sized-bg) / <alpha-value>)",
            foreground: "hsl(var(--status-sized-foreground) / <alpha-value>)",
          },
          sent: {
            DEFAULT: "hsl(var(--status-sent) / <alpha-value>)",
            bg: "hsl(var(--status-sent-bg) / <alpha-value>)",
            foreground: "hsl(var(--status-sent-foreground) / <alpha-value>)",
          },
          won: {
            DEFAULT: "hsl(var(--status-won) / <alpha-value>)",
            bg: "hsl(var(--status-won-bg) / <alpha-value>)",
            foreground: "hsl(var(--status-won-foreground) / <alpha-value>)",
          },
          installed: {
            DEFAULT: "hsl(var(--status-installed) / <alpha-value>)",
            bg: "hsl(var(--status-installed-bg) / <alpha-value>)",
            foreground: "hsl(var(--status-installed-foreground) / <alpha-value>)",
          },
          lost: {
            DEFAULT: "hsl(var(--status-lost) / <alpha-value>)",
            bg: "hsl(var(--status-lost-bg) / <alpha-value>)",
            foreground: "hsl(var(--status-lost-foreground) / <alpha-value>)",
          },
        },

        // ── Charts (series + furniture) ─────────────────────────────────────
        chart: {
          "1": "hsl(var(--chart-1) / <alpha-value>)",
          "2": "hsl(var(--chart-2) / <alpha-value>)",
          "3": "hsl(var(--chart-3) / <alpha-value>)",
          "4": "hsl(var(--chart-4) / <alpha-value>)",
          "5": "hsl(var(--chart-5) / <alpha-value>)",
          grid: "hsl(var(--chart-grid) / <alpha-value>)",
          axis: "hsl(var(--chart-axis) / <alpha-value>)",
          baseline: "hsl(var(--chart-baseline) / <alpha-value>)",
        },

        // ── A/B delta pair ──────────────────────────────────────────────────
        delta: {
          positive: "hsl(var(--delta-positive) / <alpha-value>)",
          negative: "hsl(var(--delta-negative) / <alpha-value>)",
        },

        // DEPRECATED — removed at 3.16. 208 legacy call sites still bind to these
        // raw hexes; new code binds to the semantic tokens above, never to enrg-*.
        enrg: {
          amber: "#FFB428",
          orange: "#FF6B35",
          blue: "#378ADD",
          dark: "#090E1C",
          dark2: "#0F1628",
          dark3: "#161E33",
          text: "#F0F4FF",
        },
      },

      // DESIGN.md rounded: explicit scale, default md/8px (see --radius in globals.css).
      borderRadius: {
        none: "0px",
        xs: "2px",
        sm: "6px",
        DEFAULT: "var(--radius)", // 0.5rem = md
        md: "8px",
        lg: "12px",
        xl: "16px",
        "2xl": "20px",
        "3xl": "24px",
        "4xl": "28px",
        full: "9999px",
      },

      fontFamily: {
        // Inter for everything (decision #27)…
        sans: [
          "var(--font-inter)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        // …Syne ExtraBold for the three brand-display headlines ONLY.
        display: ["var(--font-syne)", "sans-serif"],
        // DEPRECATED alias — removed at 3.16 with the legacy screens that use font-syne.
        syne: ["var(--font-syne)", "sans-serif"],
      },

      // The 18 type roles from DESIGN.md typography: (letterSpacing % → em).
      fontSize: {
        "hero-xl": ["56px", { lineHeight: "60px", fontWeight: "800", letterSpacing: "-0.035em" }],
        hero: ["40px", { lineHeight: "44px", fontWeight: "800", letterSpacing: "-0.035em" }],
        "hero-sub": ["30px", { lineHeight: "36px", fontWeight: "800", letterSpacing: "-0.03em" }],
        display: ["30px", { lineHeight: "36px", fontWeight: "700", letterSpacing: "-0.02em" }],
        h1: ["24px", { lineHeight: "32px", fontWeight: "600", letterSpacing: "-0.01em" }],
        h2: ["20px", { lineHeight: "28px", fontWeight: "600", letterSpacing: "-0.01em" }],
        h3: ["16px", { lineHeight: "24px", fontWeight: "600", letterSpacing: "0em" }],
        "body-lg": ["16px", { lineHeight: "26px", fontWeight: "400", letterSpacing: "0em" }],
        body: ["14px", { lineHeight: "20px", fontWeight: "400", letterSpacing: "0em" }],
        "body-medium": ["14px", { lineHeight: "20px", fontWeight: "500", letterSpacing: "0em" }],
        label: ["13px", { lineHeight: "18px", fontWeight: "500", letterSpacing: "0em" }],
        button: ["14px", { lineHeight: "20px", fontWeight: "600", letterSpacing: "0em" }],
        nav: ["14px", { lineHeight: "20px", fontWeight: "500", letterSpacing: "0em" }],
        caption: ["12px", { lineHeight: "16px", fontWeight: "500", letterSpacing: "0.01em" }],
        overline: ["11px", { lineHeight: "15px", fontWeight: "600", letterSpacing: "0.06em" }],
        eyebrow: ["14px", { lineHeight: "15px", fontWeight: "600", letterSpacing: "0.1em" }],
        "metric-lg": ["28px", { lineHeight: "32px", fontWeight: "600", letterSpacing: "-0.01em" }],
        "metric-sm": ["18px", { lineHeight: "24px", fontWeight: "600" }],
      },

      backgroundImage: {
        // Canonical 4-stop brand gradient (identical both modes).
        "brand-gradient": "var(--brand-gradient)",
        // DEPRECATED alias — removed at 3.16. 14 legacy call sites use
        // bg-enrg-gradient; it now resolves to the corrected 4-stop gradient.
        "enrg-gradient": "var(--brand-gradient)",
      },

      // Elevation goes through variables because the two modes differ structurally:
      // dark elev-1 is `none` (depth = surface lightening + hairline, never a shadow).
      boxShadow: {
        "elev-1": "var(--shadow-elev-1)",
        "elev-2": "var(--shadow-elev-2)",
        "elev-3": "var(--shadow-elev-3)",
        "focus-ring": "var(--shadow-focus-ring)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
