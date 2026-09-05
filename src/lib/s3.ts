import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** The bucket's own region wins; everything else comes from the environment. */
function client(region: string): S3Client {
  return new S3Client({
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
}

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
  return getSignedUrl(
    client(region),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSecs }
  );
}

/**
 * Deletes a recording's object from S3.
 *
 * Only reached from the admin panel, and only when an administrator asks for
 * the file itself to go rather than just the row that points at it. S3 has no
 * undo here, which is why the two are separate actions.
 */
export async function deleteRecordingObject(
  bucket: string,
  region: string,
  key: string
): Promise<void> {
  await client(region).send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key })
  );
}
