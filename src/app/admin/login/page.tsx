import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AdminLogin from "@/components/AdminLogin";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  // Already an administrator? Then this page has nothing to ask.
  const user = await getSession();
  if (user?.isAdmin) redirect("/admin");

  // A signed-in non-administrator still sees the form: switching to an admin
  // account should not require signing out of their own first.
  return (
    <Suspense>
      <AdminLogin />
    </Suspense>
  );
}
