import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from "livekit-server-sdk";

/**
 * Shared helpers for LiveKit Egress recording that uploads to Amazon S3.
 *
 * Recording is done server-side: LiveKit's egress service renders the whole
 * room (a "room composite") into a single MP4 and uploads it straight to your
 * S3 bucket. Nothing streams through this Next.js server, so it scales fine.
 */

export type S3Config = {
  accessKey: string;
  secret: string;
  region: string;
  bucket: string;
  /** Optional custom endpoint (e.g. for S3-compatible stores like MinIO/R2). */
  endpoint?: string;
  forcePathStyle?: boolean;
};

/** LiveKit egress + AWS creds read from the environment. */
export type RecordingConfig = {
  host: string; // https:// LiveKit URL for the server SDK
  apiKey: string;
  apiSecret: string;
  s3: S3Config;
};

/**
 * The server SDK talks to LiveKit over https, but the app stores a wss:// URL
 * for the browser. Normalise whatever is configured into an https host.
 */
export function livekitHttpUrl(): string | null {
  const raw =
    process.env.LIVEKIT_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL || "";
  if (!raw) return null;
  return raw.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

/**
 * Collects everything needed to record to S3, or returns a human-readable
 * reason why recording is unavailable so the API can surface it.
 */
export function getRecordingConfig():
  | { ok: true; config: RecordingConfig }
  | { ok: false; error: string } {
  const host = livekitHttpUrl();
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host) {
    return { ok: false, error: "LIVEKIT_URL is not set." };
  }
  if (!apiKey || !apiSecret) {
    return {
      ok: false,
      error: "LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set.",
    };
  }

  const accessKey =
    process.env.AWS_S3_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.S3_ACCESS_KEY;
  const secret =
    process.env.AWS_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.S3_SECRET_KEY;
  const region =
    process.env.AWS_S3_REGION ||
    process.env.AWS_REGION ||
    process.env.S3_REGION;
  const bucket =
    process.env.AWS_S3_BUCKET_NAME ||
    process.env.S3_BUCKET ||
    process.env.AWS_S3_BUCKET;
  if (!accessKey || !secret || !region || !bucket) {
    return {
      ok: false,
      error:
        "S3 is not configured. Set AWS_S3_BUCKET_NAME, AWS_S3_REGION, AWS_S3_ACCESS_KEY_ID and AWS_S3_SECRET_ACCESS_KEY in .env.local",
    };
  }

  const endpoint = process.env.S3_ENDPOINT || undefined;
  return {
    ok: true,
    config: {
      host,
      apiKey,
      apiSecret,
      s3: {
        accessKey,
        secret,
        region,
        bucket,
        endpoint,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      },
    },
  };
}

export function egressClient(config: RecordingConfig): EgressClient {
  return new EgressClient(config.host, config.apiKey, config.apiSecret);
}

/**
 * Builds the MP4-to-S3 output for a room. The object key uses LiveKit's
 * template vars ({room_name}/{time}) so every recording lands in its own path.
 */
export function buildFileOutput(
  room: string,
  s3: S3Config
): { output: EncodedFileOutput; keyTemplate: string } {
  const safeRoom = room.replace(/[^a-zA-Z0-9._-]/g, "_");
  const keyTemplate = `recordings/${safeRoom}/{room_name}-{time}.mp4`;
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: keyTemplate,
    disableManifest: true,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: s3.accessKey,
        secret: s3.secret,
        region: s3.region,
        bucket: s3.bucket,
        ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
        forcePathStyle: s3.forcePathStyle ?? false,
      }),
    },
  });
  return { output, keyTemplate };
}
