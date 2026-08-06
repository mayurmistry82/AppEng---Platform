import Link from "next/link";

export default function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="mb-2 font-syne text-xs font-bold uppercase tracking-[0.22em] text-enrg-amber">
        How it works
      </p>
      <h1 className="font-syne text-3xl font-extrabold tracking-tight text-foreground">
        The analysis pipeline.
      </h1>
      <h2 className="bg-gradient-to-r from-enrg-amber via-enrg-orange to-enrg-blue bg-clip-text font-syne text-3xl font-extrabold tracking-tight text-transparent">
        Every assumption. Every source.
      </h2>
      <p className="mt-4 max-w-xl text-sm text-muted-foreground">
        Each stage shows exactly what data goes in, where it comes from, and
        what it produces. Customer inputs are in amber. API and external data
        calls are in blue. Everything is overrideable.
      </p>

      {/* Axis bar */}
      <div className="relative mb-12 mt-10">
        <div
          className="h-[3px] w-full rounded-full"
          style={{
            background:
              "linear-gradient(90deg, #FFB428 0%, #FFB428 20%, #FF6B35 35%, #FF6B35 65%, #378ADD 80%, #1A4A8C 100%)",
          }}
        />
        {[
          {
            pct: "17%",
            dotCls: "bg-enrg-amber",
            label: "INPUTS",
            textCls: "text-enrg-amber",
          },
          {
            pct: "50%",
            dotCls: "bg-enrg-orange",
            label: "ENGINE",
            textCls: "text-enrg-orange",
          },
          {
            pct: "83%",
            dotCls: "bg-enrg-blue",
            label: "OUTPUTS",
            textCls: "text-enrg-blue",
          },
        ].map(({ pct, dotCls, label, textCls }) => (
          <div
            key={label}
            className="absolute"
            style={{ left: pct, transform: "translateX(-50%)" }}
          >
            <div
              className={`-mt-[6px] h-3 w-3 rounded-full border-2 border-enrg-dark ${dotCls}`}
            />
            <p
              className={`mt-2 whitespace-nowrap font-syne text-[10px] font-bold uppercase tracking-[0.22em] ${textCls}`}
            >
              {label}
            </p>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mb-10 flex flex-wrap gap-4">
        {(
          [
            {
              label: "Customer Input",
              cls: "bg-enrg-amber/15 text-enrg-amber border-enrg-amber/40",
            },
            {
              label: "API Call",
              cls: "bg-enrg-blue/10 text-enrg-blue border-enrg-blue/30",
            },
            {
              label: "Internal Database",
              cls: "bg-white/5 text-muted-foreground border-white/10",
            },
            {
              label: "Installer Override",
              cls: "bg-enrg-orange/10 text-enrg-orange border-enrg-orange/30",
            },
          ] as const
        ).map(({ label, cls }) => (
          <span
            key={label}
            className={`rounded-full border px-2.5 py-1 font-syne text-[10px] font-bold uppercase tracking-wider ${cls}`}
          >
            {label}
          </span>
        ))}
      </div>

      {/* Navigation grid to all stages */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
          <Link
            key={n}
            href={`/dashboard/workflow/stage-${n}`}
            className="rounded-md border border-white/10 px-4 py-3 text-center transition hover:border-enrg-amber/40 hover:bg-enrg-amber/5"
          >
            <p className="font-syne text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Stage {n}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
