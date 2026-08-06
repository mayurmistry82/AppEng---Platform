import BillPanel from "@/components/panels/BillPanel";

export default function BillUploadPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-4 text-xs text-muted-foreground">
          Home › Customer Input › Bill Upload
        </p>
        <h1 className="font-syne text-2xl font-extrabold tracking-tight text-foreground">
          Bill Upload
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a customer electricity bill. Usage data is auto-extracted and
          stored.
        </p>
      </div>
      <BillPanel />
    </div>
  );
}
