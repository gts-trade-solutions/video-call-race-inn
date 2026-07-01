import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import ChatClient from "@/components/ChatClient";

export default async function ChatPage() {
  const user = await getSession();
  if (!user) redirect("/login?next=/chat");
  return (
    <AppShell user={user}>
      <ChatClient user={user} />
    </AppShell>
  );
}
