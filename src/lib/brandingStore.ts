import { ensureSchema, getPool } from "@/lib/db";
import type { RowDataPacket } from "mysql2";
import {
  COLOR_FIELDS,
  DEFAULT_BRANDING,
  LOGO_FIELDS,
  TEXT_FIELDS,
  type Branding,
} from "@/lib/branding";

/**
 * Reading and writing the brand.
 *
 * Split from lib/branding, which holds the defaults and the validators, so
 * that the client components showing a wordmark can import those without
 * dragging mysql2 into the browser bundle along with them.
 *
 * The root layout reads the brand on every render, so it is cached in-process.
 * Short TTL rather than forever: `forgetBranding` clears it on save so the
 * editor sees the change at once, but a second app instance (or a row changed
 * by hand in MySQL) still catches up on its own within the minute.
 */
const TTL_MS = 60_000;
const cache = globalThis as unknown as {
  _branding?: { value: Branding; at: number };
};

export function forgetBranding() {
  cache._branding = undefined;
}

/**
 * Never throws.
 *
 * The root layout wraps every page including sign-in, and before this the
 * layout touched no database at all. Letting a failed query propagate would
 * turn "MySQL is down" into a blank 500 for the entire app rather than the
 * sign-in page it used to still render. Defaults are always a usable answer.
 */
export async function getBranding(): Promise<Branding> {
  const now = Date.now();
  if (cache._branding && now - cache._branding.at < TTL_MS) {
    return cache._branding.value;
  }
  let value = DEFAULT_BRANDING;
  try {
    // Deliberately no ensureSchema() here. This runs on every page render, and
    // ensureSchema issues DDL — during a build, fourteen pages rendering at
    // once turned that into concurrent ALTERs on the same tables and MySQL
    // deadlocked on them. A render should read, never migrate. The table is
    // created by the API routes, which do call ensureSchema; until one has,
    // the query fails with "no such table" and the defaults below are correct.
    const [rows] = await getPool().query<RowDataPacket[]>(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'branding.%'"
    );
    const overrides: Record<string, string> = {};
    for (const r of rows) {
      const key = String(r.setting_key).slice("branding.".length);
      const v = r.setting_value;
      if (typeof v === "string" && v !== "") overrides[key] = v;
    }
    value = { ...DEFAULT_BRANDING };
    // Every field, from one list. Keeping a loop per kind meant a new kind of
    // field could be saved and read back by the admin panel while never
    // reaching the pages — which is precisely what the logo background colours
    // did until this became one loop.
    for (const f of [...TEXT_FIELDS, ...LOGO_FIELDS, ...COLOR_FIELDS]) {
      if (overrides[f]) value[f] = overrides[f];
    }
  } catch (err) {
    // 1146 is "table doesn't exist", which is the ordinary state of a database
    // the app has not finished starting against — not worth a log line.
    if ((err as { errno?: number }).errno !== 1146) {
      console.error("branding: falling back to defaults:", err);
    }
  }
  cache._branding = { value, at: now };
  return value;
}

/**
 * Writes the given fields. A field set to its default (or to an empty string)
 * has its row deleted rather than stored, so "reset to default" really is the
 * absence of an override and a later change to the defaults still reaches it.
 */
export async function saveBranding(
  changes: Partial<Branding>,
  actorId: number
): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  const entries = Object.entries(changes) as [keyof Branding, unknown][];
  for (const [field, raw] of entries) {
    const key = `branding.${field}`;
    const isDefault =
      raw === null || raw === "" || raw === DEFAULT_BRANDING[field];
    if (isDefault) {
      await pool.query("DELETE FROM app_settings WHERE setting_key = :key", {
        key,
      });
      continue;
    }
    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_by)
       VALUES (:key, :value, :actor)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                               updated_by = VALUES(updated_by)`,
      { key, value: String(raw), actor: actorId }
    );
  }
  forgetBranding();
}
