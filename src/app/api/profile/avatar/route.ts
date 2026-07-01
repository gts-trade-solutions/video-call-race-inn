import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { getSession, createSession } from "@/lib/auth";
import type { ResultSetHeader } from "mysql2";

export const dynamic = "force-dynamic";

// POST { url } — set (or clear, if url is null) the current user's photo,
// then refresh the session so it carries the new avatar.
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const me = await getSession();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { url } = await req.json();
    const avatarUrl =
      url && typeof url === "string" ? url.slice(0, 255) : null;

    const pool = getPool();
    await pool.query<ResultSetHeader>(
      "UPDATE users SET avatar_url = :url WHERE id = :id",
      { url: avatarUrl, id: me.id }
    );

    // Re-issue the session cookie with the updated avatar.
    await createSession({
      id: me.id,
      name: me.name,
      email: me.email,
      avatarUrl,
    });

    return NextResponse.json({ ok: true, avatarUrl });
  } catch (err) {
    console.error("avatar update error:", err);
    return NextResponse.json(
      { error: "Could not update photo." },
      { status: 500 }
    );
  }
}
