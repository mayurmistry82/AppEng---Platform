import { redirect } from "next/navigation";
import CustomerSitePanel from "@/components/panels/CustomerSitePanel";
import InstallerProfilePanel from "@/components/panels/InstallerProfilePanel";
import { createClient } from "@/lib/supabase/server";

export default async function SiteInfoPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="space-y-0">
      <div className="mb-8">
        <p className="mb-4 text-xs text-muted-foreground">
          Home › Customer Input › Site Information
        </p>
        <h1 className="font-syne text-2xl font-extrabold tracking-tight text-foreground">
          Site Information
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your installer profile and customer site details.
        </p>
      </div>
      <InstallerProfilePanel userId={user.id} />
      <div className="my-8 border-t border-white/[0.06]" />
      <CustomerSitePanel />
    </div>
  );
}
