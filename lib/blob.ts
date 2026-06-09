import { put } from "@vercel/blob";

/**
 * Upload a screenshot PNG to Vercel Blob and return its public URL.
 *
 * Stored under `pr-review/<runId>/<name>` with a random suffix so re-runs never
 * collide. Needs `BLOB_READ_WRITE_TOKEN` (auto-injected on Vercel when a Blob
 * store is connected to the project; set it manually for local dev).
 */
export async function uploadShot(
  runId: string,
  name: string,
  buf: Buffer,
): Promise<string> {
  const { url } = await put(`pr-review/${runId}/${name}`, buf, {
    access: "public",
    addRandomSuffix: true,
    contentType: "image/png",
  });
  return url;
}
