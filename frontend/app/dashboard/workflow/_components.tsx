"use client";

export type { InputType, InputRow, Stage } from "./_data";
export {
  STAGES,
  INPUT_BADGE_LABEL,
  INPUT_BADGE_CLS,
  THEME_CLS,
} from "./_data";

import type { InputType, Stage } from "./_data";
import { INPUT_BADGE_LABEL, INPUT_BADGE_CLS, THEME_CLS } from "./_data";

export function InputBadge({ type }: { type: InputType }) {
  return (
    <span
      className={`mr-2 inline-block rounded-full border px-2 py-0.5 font-syne text-[9px] font-bold uppercase tracking-wider ${INPUT_BADGE_CLS[type]}`}
    >
      {INPUT_BADGE_LABEL[type]}
    </span>
  );
}

export function StageCard({ stage }: { stage: Stage }) {
  const t = THEME_CLS[stage.theme];
  return (
    <div className={`border-l-4 pl-5 pr-4 py-6 transition-colors ${t.card}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 font-syne text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Stage {stage.number} · {stage.sublabel}
          </p>
          <h2
            className={`font-syne text-lg font-extrabold tracking-tight ${t.heading}`}
          >
            {stage.name}
          </h2>
        </div>
      </div>

      {stage.noInputsNote && (
        <p className="mb-3 text-xs italic text-muted-foreground">
          {stage.noInputsNote}
        </p>
      )}

      {stage.inputs.length > 0 && (
        <div className="mb-4 space-y-3">
          {stage.inputs.map((row, i) => (
            <div key={i}>
              <div className="flex items-baseline gap-1">
                <InputBadge type={row.type} />
                <span className="text-sm font-medium text-foreground">
                  {row.label}
                </span>
              </div>
              {row.detail && row.detail.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 pl-4">
                  {row.detail.map((d, j) => (
                    <li
                      key={j}
                      className="flex gap-2 text-xs text-muted-foreground"
                    >
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-white/20" />
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {stage.processing && stage.processing.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 font-syne text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Processing
          </p>
          <ul className="space-y-1">
            {stage.processing.map((step, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-white/20" />
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-white/10 pt-4">
        <p className="mb-1 font-syne text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Output
        </p>
        <p className="text-sm text-foreground/80">{stage.output}</p>
      </div>
    </div>
  );
}

export function StageArrow() {
  return (
    <div className="my-2 flex justify-center">
      <div className="h-8 w-px bg-gradient-to-b from-white/20 to-white/5" />
    </div>
  );
}
