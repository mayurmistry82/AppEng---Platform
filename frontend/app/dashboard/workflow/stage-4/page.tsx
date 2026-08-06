import { STAGES } from "../_data";
import { StageCard } from "../_components";

export default function Stage4Page() {
  const stage = STAGES.find((s) => s.number === 4)!;
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="mb-8 font-syne text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">
        Workflow <span className="mx-2 text-white/20">·</span> Stage 4
      </p>
      <StageCard stage={stage} />
    </div>
  );
}
