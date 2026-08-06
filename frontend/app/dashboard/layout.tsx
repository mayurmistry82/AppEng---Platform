import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import SidebarToggle from "@/components/SidebarToggle";
import { createClient } from "@/lib/supabase/server";

async function signOutAction() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden bg-enrg-dark">
      <Sidebar
        userEmail={user.email ?? ""}
        signOutAction={signOutAction}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-11 flex-shrink-0 items-center border-b border-white/10 px-4">
          <SidebarToggle />
        </div>
        <main className="flex-1 overflow-y-auto px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
