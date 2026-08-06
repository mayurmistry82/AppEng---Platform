import RunAnalysisButton from "@/components/RunAnalysisButton";
import IntervalDataPanel from "@/components/panels/IntervalDataPanel";
import SurveyPanel from "@/components/panels/SurveyPanel";

export default function LoadSurveyPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-4 text-xs text-muted-foreground">
          Home › Customer Input › Load Survey
        </p>
        <h1 className="font-syne text-2xl font-extrabold tracking-tight text-foreground">
          Load Survey
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Household details that refine the load profile and improve sizing
          accuracy.
        </p>
      </div>
      <SurveyPanel />
      <div className="border-t border-white/[0.06] pt-2">
        <IntervalDataPanel />
      </div>
      <RunAnalysisButton />
    </div>
  );
}
