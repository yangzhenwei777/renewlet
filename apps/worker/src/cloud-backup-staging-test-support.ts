import { vi } from "vitest";

export function createCloudBackupBucket() {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string> }>();
  const put = vi.fn(async (key: string, bytes: Uint8Array<ArrayBuffer>, options?: R2PutOptions) => {
    objects.set(key, { bytes: bytes.slice(), metadata: options?.customMetadata ?? {} });
    return { key };
  });
  const head = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? { key, size: object.bytes.length, httpMetadata: { contentType: "image/svg+xml" } } : null;
  });
  const get = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? {
      key, size: object.bytes.length, customMetadata: object.metadata,
      body: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close(); } }),
      arrayBuffer: async () => object.bytes.slice().buffer,
    } : null;
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
  });
  return { objects, put, get, head, remove, bucket: { put, get, head, delete: remove } as unknown as R2Bucket };
}
