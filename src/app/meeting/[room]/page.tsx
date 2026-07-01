import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import MeetingRoom from "@/components/MeetingRoom";

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: { room: string };
  searchParams: { mode?: string };
}) {
  const user = await getSession();
  if (!user) redirect(`/login?next=/meeting/${params.room}`);

  return (
    <MeetingRoom
      room={params.room}
      userName={user.name}
      audioOnly={searchParams.mode === "audio"}
    />
  );
}
