import { redirect } from "next/navigation";
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
    <div className="min-h-screen bg-enrg-dark">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="bg-gradient-to-r from-enrg-amber to-enrg-orange bg-clip-text font-syne text-xl font-extrabold tracking-tight text-transparent">
            EnrgEngine
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user.email}</span>
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-syne text-xs font-bold uppercase tracking-wider text-foreground transition hover:border-enrg-amber hover:text-enrg-amber"
              >
                Sign Out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
