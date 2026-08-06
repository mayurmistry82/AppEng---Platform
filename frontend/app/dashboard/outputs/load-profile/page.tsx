"use client";

import LoadProfilePanel from "@/components/panels/LoadProfilePanel";
import { useDashboardStore } from "@/lib/store";

export default function LoadProfilePage() {
  const billData = useDashboardStore((s) => s.billData);
  const surveyInputs = useDashboardStore((s) => s.surveyInputs);

  if (!billData) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Upload a customer bill on the Inputs tab to generate a load profile.
        </p>
      </div>
    );
  }

  if (!surveyInputs) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Complete the Load Survey on the Inputs tab to generate a load profile.
        </p>
      </div>
    );
  }

  return <LoadProfilePanel />;
}
