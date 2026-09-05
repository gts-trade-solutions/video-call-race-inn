import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ensureSchema, getPool } from "@/lib/db";
import type { RowDataPacket } from "mysql2";
import MeetingRoom from "@/components/MeetingRoom";

export const dynamic = "force-dynamic";

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: { room: string };
  searchParams: { mode?: string };
}) {
  const user = await getSession();
  if (!user) redirect(`/api/auth/logout?next=/meeting/${params.room}`);

  // Show the real meeting title in the call header instead of just the id.
  let title = "";
  try {
    await ensureSchema();
    const [rows] = await getPool().query<RowDataPacket[]>(
      "SELECT title FROM meetings WHERE room_id = :room LIMIT 1",
      { room: params.room }
    );
    title = (rows[0]?.title as string) || "";
  } catch {
    /* the call works without it */
  }

  return (
    <MeetingRoom
      room={params.room}
      title={title}
      userName={user.name}
      audioOnly={searchParams.mode === "audio"}
    />
  );
}
