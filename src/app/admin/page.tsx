import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import AdminClient from "@/components/AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getSession();
  // Holding a cookie whose account is gone — middleware still reads it as
  // valid, so clear it on the way past rather than bouncing off middleware.
  if (!user) redirect("/api/auth/logout?next=/admin/login");

  // Signed in, just not an administrator. The admin sign-in rather than the
  // app's: they may well have an admin account, just not the one they are
  // currently using, and this is where they can switch to it.
  if (!user.isAdmin) redirect("/admin/login?reason=notadmin");

  return (
    <AppShell user={user}>
      <AdminClient user={user} />
    </AppShell>
  );
}
