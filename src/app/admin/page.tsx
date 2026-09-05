import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import AdminClient from "@/components/AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getSession();
  // Signed out, or holding a cookie whose account is gone: clear it on the way
  // to sign-in rather than bouncing off middleware, which still reads the
  // cookie as valid.
  if (!user) redirect("/api/auth/logout?next=/admin");

  // Signed in, just not an administrator. Sending them to sign in again would
  // suggest the wrong problem and wouldn't fix it either.
  if (!user.isAdmin) redirect("/dashboard");

  return (
    <AppShell user={user}>
      <AdminClient user={user} />
    </AppShell>
  );
}
