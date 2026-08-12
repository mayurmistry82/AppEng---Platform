import { redirect } from "next/navigation";
import AppRail from "@/components/AppRail";
import { createClient } from "@/lib/supabase/server";

/**
 * New app shell (Stage 2.2): icon rail + content. Runs alongside the old
 * /dashboard tree (deliberately — two shells coexist until 3.16 retires that one).
 * Middleware already denies unauthenticated access; the getUser here is for the
 * rail's account popover, with a belt-and-braces redirect.
 */

async function signOutAction() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function AppShellLayout({
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
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <AppRail userEmail={user.email ?? ""} signOutAction={signOutAction} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
