import JobAutoSave from "@/components/JobAutoSave";

export default function OutputsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0">
      <div className="mb-6">
        <h1 className="font-syne text-2xl font-extrabold tracking-tight text-foreground">
          Analysis Results
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Step through each section to review the full analysis.
        </p>
      </div>
      {/* Persists the job record once analysis data is ready (best-effort). */}
      <JobAutoSave />
      {children}
    </div>
  );
}
