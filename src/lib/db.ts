import mysql from "mysql2/promise";

// A single shared connection pool across hot reloads in dev.
const globalForDb = globalThis as unknown as {
  _mysqlPool?: mysql.Pool;
  _schemaReady?: Promise<void>;
};

// Read connection settings. Supports both MYSQL_* and DB_* env names.
function dbConfig() {
  return {
    host: process.env.MYSQL_HOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER || "root",
    password: process.env.MYSQL_PASSWORD ?? process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE || "video_call_tool",
  };
}

export function getPool(): mysql.Pool {
  if (!globalForDb._mysqlPool) {
    const cfg = dbConfig();
    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      namedPlaceholders: true,
      // Parse/serialize all DATETIME/TIMESTAMP values as UTC so scheduled
      // meeting times and reset-token expiry aren't shifted by the server's
      // local timezone.
      timezone: "Z",
    });
    // The DB session timezone otherwise defaults to the server's SYSTEM tz,
    // which corrupts the UTC wall-clock strings we insert (a reset token would
    // appear already-expired, scheduled times would be off). Pin it to UTC.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool.on("connection", (conn: any) => {
      conn.query("SET time_zone='+00:00'");
    });
    globalForDb._mysqlPool = pool;
  }
  return globalForDb._mysqlPool;
}

/**
 * Ensures the database and tables exist. Runs once per process.
 * Creating the schema on boot keeps setup to "just point at a MySQL server".
 */
export function ensureSchema(): Promise<void> {
  if (!globalForDb._schemaReady) {
    globalForDb._schemaReady = (async () => {
      const cfg = dbConfig();
      const dbName = cfg.database;

      // Connect without a database to create it if missing.
      const root = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        multipleStatements: true,
      });
      await root.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await root.end();

      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          email VARCHAR(190) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS meetings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          room_id VARCHAR(64) NOT NULL UNIQUE,
          title VARCHAR(190) NOT NULL,
          host_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_host (host_id),
          CONSTRAINT fk_meetings_host FOREIGN KEY (host_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Records each time a user joins a meeting (for "recent meetings").
      await pool.query(`
        CREATE TABLE IF NOT EXISTS meeting_participants (
          id INT AUTO_INCREMENT PRIMARY KEY,
          meeting_id INT NOT NULL,
          user_id INT NOT NULL,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user (user_id),
          INDEX idx_meeting (meeting_id),
          CONSTRAINT fk_part_meeting FOREIGN KEY (meeting_id)
            REFERENCES meetings(id) ON DELETE CASCADE,
          CONSTRAINT fk_part_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // 1:1 direct messages (Teams-style persistent chat).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          sender_id INT NOT NULL,
          recipient_id INT NOT NULL,
          body TEXT NOT NULL,
          read_at TIMESTAMP NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_pair (sender_id, recipient_id),
          INDEX idx_recipient (recipient_id),
          CONSTRAINT fk_msg_sender FOREIGN KEY (sender_id)
            REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_msg_recipient FOREIGN KEY (recipient_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Group chats.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_groups (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(190) NOT NULL,
          avatar_url VARCHAR(255) NULL,
          created_by INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_group_creator FOREIGN KEY (created_by)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS group_members (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_id INT NOT NULL,
          user_id INT NOT NULL,
          last_read_at TIMESTAMP NULL DEFAULT NULL,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_member (group_id, user_id),
          INDEX idx_gm_user (user_id),
          CONSTRAINT fk_gm_group FOREIGN KEY (group_id)
            REFERENCES chat_groups(id) ON DELETE CASCADE,
          CONSTRAINT fk_gm_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      // messages.group_id lets the messages table carry group messages too.
      try {
        await pool.query("ALTER TABLE messages ADD COLUMN group_id INT NULL");
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: add reply_to_id to messages if it doesn't exist yet.
      // (MySQL has no ADD COLUMN IF NOT EXISTS; ignore "duplicate column".)
      try {
        await pool.query(
          "ALTER TABLE messages ADD COLUMN reply_to_id INT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: soft-delete column ("delete for everyone").
      try {
        await pool.query(
          "ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: edited timestamp.
      try {
        await pool.query(
          "ALTER TABLE messages ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: scheduled time for meetings (null = instant meeting link).
      try {
        await pool.query(
          "ALTER TABLE meetings ADD COLUMN scheduled_at TIMESTAMP NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: meeting length in minutes (used for calendar event end time).
      try {
        await pool.query(
          "ALTER TABLE meetings ADD COLUMN duration_mins INT NOT NULL DEFAULT 30"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: link to the Google Calendar event we created (if synced).
      try {
        await pool.query(
          "ALTER TABLE meetings ADD COLUMN google_event_id VARCHAR(255) NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }
      try {
        await pool.query(
          "ALTER TABLE meetings ADD COLUMN google_html_link VARCHAR(512) NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Password reset codes — we store only a hash of the 4-digit PIN.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS password_resets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          token_hash VARCHAR(255) NOT NULL,
          attempts INT NOT NULL DEFAULT 0,
          expires_at TIMESTAMP NOT NULL,
          used_at TIMESTAMP NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_pr_token (token_hash),
          INDEX idx_pr_user (user_id),
          CONSTRAINT fk_pr_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      // Migration: attempt counter for existing password_resets tables.
      try {
        await pool.query(
          "ALTER TABLE password_resets ADD COLUMN attempts INT NOT NULL DEFAULT 0"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Google Calendar OAuth tokens, one row per connected user.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS google_calendar_tokens (
          user_id INT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT NULL,
          scope TEXT NULL,
          token_type VARCHAR(40) NULL,
          expiry_ts BIGINT NULL,
          google_email VARCHAR(190) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_gct_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Migration: profile photo URL on users.
      try {
        await pool.query(
          "ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Migration: presence — last activity timestamp.
      try {
        await pool.query(
          "ALTER TABLE users ADD COLUMN last_seen TIMESTAMP NULL DEFAULT NULL"
        );
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1060) throw e;
      }

      // Call recordings (LiveKit Egress → S3). One row per recording session.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS recordings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          room_id VARCHAR(64) NOT NULL,
          egress_id VARCHAR(190) NOT NULL UNIQUE,
          started_by INT NULL,
          status ENUM('recording','completing','completed','failed') NOT NULL DEFAULT 'recording',
          s3_bucket VARCHAR(190) NULL,
          s3_region VARCHAR(64) NULL,
          s3_key VARCHAR(512) NULL,
          duration_secs INT NULL,
          size_bytes BIGINT NULL,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ended_at TIMESTAMP NULL DEFAULT NULL,
          INDEX idx_rec_room (room_id),
          INDEX idx_rec_status (status),
          CONSTRAINT fk_rec_user FOREIGN KEY (started_by)
            REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Emoji reactions on messages (one row per user+emoji+message).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS message_reactions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          message_id INT NOT NULL,
          user_id INT NOT NULL,
          emoji VARCHAR(16) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_reaction (message_id, user_id, emoji),
          INDEX idx_msg (message_id),
          CONSTRAINT fk_reaction_msg FOREIGN KEY (message_id)
            REFERENCES messages(id) ON DELETE CASCADE,
          CONSTRAINT fk_reaction_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    })().catch((err) => {
      // Reset so a later request can retry (e.g. DB was down at boot).
      globalForDb._schemaReady = undefined;
      throw err;
    });
  }
  return globalForDb._schemaReady;
}

export type DBUser = {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
};

export type DBMeeting = {
  id: number;
  room_id: string;
  title: string;
  host_id: number;
  created_at: string;
};

export type DBRecording = {
  id: number;
  room_id: string;
  egress_id: string;
  started_by: number | null;
  status: "recording" | "completing" | "completed" | "failed";
  s3_bucket: string | null;
  s3_region: string | null;
  s3_key: string | null;
  duration_secs: number | null;
  size_bytes: number | null;
  started_at: string;
  ended_at: string | null;
};
