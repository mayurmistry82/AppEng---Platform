"use client";

import { useRouter } from "next/navigation";

export default function RunAnalysisButton() {
  const router = useRouter();
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => router.push("/dashboard/outputs")}
        className="rounded-md bg-enrg-gradient px-6 py-2.5 font-syne text-sm font-extrabold uppercase tracking-wider text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0"
      >
        Run Analysis →
      </button>
    </div>
  );
}
