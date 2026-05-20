const PANELS = [
  { title: "Bill Data", subtitle: "Upload a bill to begin" },
  { title: "Solar Resource", subtitle: "Irradiance data will appear here" },
  { title: "System Sizing", subtitle: "Sizing results will appear here" },
  { title: "Financial Outcomes", subtitle: "Financial model will appear here" },
  { title: "Network Constraints", subtitle: "NEM data will appear here" },
  { title: "Government Incentives", subtitle: "STC calculation will appear here" },
];

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-syne text-2xl font-extrabold tracking-tight text-foreground">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a customer bill to begin sizing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {PANELS.map((panel) => (
          <div
            key={panel.title}
            className="rounded-lg border border-white/10 border-t-2 border-t-enrg-amber bg-enrg-dark2 p-6"
          >
            <h2 className="font-syne text-lg font-bold text-foreground">
              {panel.title}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{panel.subtitle}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
