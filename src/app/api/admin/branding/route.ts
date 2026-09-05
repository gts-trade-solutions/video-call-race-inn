import { NextResponse } from "next/server";
import { adminGuard, recordAdminAction } from "@/lib/admin";
import {
  COLOR_FIELDS,
  DEFAULT_BRANDING,
  LOGO_FIELDS,
  TEXT_FIELDS,
  cleanColor,
  cleanLogo,
  cleanText,
  type Branding,
} from "@/lib/branding";
import { getBranding, saveBranding } from "@/lib/brandingStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/branding — current values, plus the defaults to reset to. */
export async function GET() {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  return NextResponse.json({
    branding: await getBranding(),
    defaults: DEFAULT_BRANDING,
  });
}

/**
 * PUT /api/admin/branding { …fields }
 *
 * Only the fields present in the body are touched, so the editor can save one
 * logo without resending eight text fields. A field sent as an empty string or
 * null is reset to its default rather than stored blank — a navbar with no
 * brand name in it is never what someone meant by clearing the box.
 */
export async function PUT(req: Request) {
  const guard = await adminGuard();
  if (!guard.ok) return guard.res;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected an object." }, { status: 400 });
  }

  const changes: Partial<Branding> = {};
  const rejected: string[] = [];

  for (const field of TEXT_FIELDS) {
    if (!(field in body)) continue;
    const value = cleanText(body[field]);
    if (value === undefined) {
      rejected.push(field);
      continue;
    }
    changes[field] = value;
  }

  for (const field of LOGO_FIELDS) {
    if (!(field in body)) continue;
    const value = cleanLogo(body[field]);
    if (value === undefined) {
      // Anything that isn't one of our own uploads. See cleanLogo for why this
      // is refused rather than trusted.
      rejected.push(field);
      continue;
    }
    changes[field] = value;
  }

  for (const field of COLOR_FIELDS) {
    if (!(field in body)) continue;
    const value = cleanColor(body[field]);
    if (value === undefined) {
      rejected.push(field);
      continue;
    }
    changes[field] = value;
  }

  if (rejected.length > 0) {
    return NextResponse.json(
      {
        error: `Couldn't accept: ${rejected.join(", ")}. Logos must be uploaded here rather than linked from elsewhere, and colours must be hex (#fff or #ffffff).`,
      },
      { status: 400 }
    );
  }
  if (Object.keys(changes).length === 0) {
    return NextResponse.json(
      { error: "Nothing to change." },
      { status: 400 }
    );
  }

  await saveBranding(changes, guard.user.id);
  await recordAdminAction(
    guard.user,
    "update",
    "branding",
    null,
    Object.keys(changes).join(", ")
  );

  return NextResponse.json({ ok: true, branding: await getBranding() });
}
