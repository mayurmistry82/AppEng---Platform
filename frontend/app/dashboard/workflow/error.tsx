"use client";

export default function WorkflowError() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <p className="text-sm text-muted-foreground">
        Workflow overview unavailable — please refresh.
      </p>
    </div>
  );
}
