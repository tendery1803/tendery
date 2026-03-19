import { S3Client } from "@aws-sdk/client-s3";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function getUploadsBucket() {
  return env("S3_BUCKET_UPLOADS");
}

export function createS3Client() {
  const endpoint = env("S3_ENDPOINT");
  const region = env("S3_REGION");
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "false") === "true";

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey }
  });
}

