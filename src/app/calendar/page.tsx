import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import CalendarClient from "@/components/CalendarClient";

export default async function CalendarPage() {
  const user = await getSession();
  if (!user) redirect("/login?next=/calendar");

  return (
    <AppShell user={user}>
      <CalendarClient user={user} />
    </AppShell>
  );
}
