import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Generates a temporary, signed download URL for a recording object so private
 * S3 buckets still work — no need to make the bucket public.
 */
export async function presignRecording(
  bucket: string,
  region: string,
  key: string,
  expiresInSecs = 3600
): Promise<string> {
  const client = new S3Client({
    region,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId:
        process.env.AWS_S3_ACCESS_KEY_ID ||
        process.env.AWS_ACCESS_KEY_ID ||
        process.env.S3_ACCESS_KEY ||
        "",
      secretAccessKey:
        process.env.AWS_S3_SECRET_ACCESS_KEY ||
        process.env.AWS_SECRET_ACCESS_KEY ||
        process.env.S3_SECRET_KEY ||
        "",
    },
  });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: expiresInSecs,
  });
}
