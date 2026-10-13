import { afterEach, describe, expect, it, vi } from "vitest";
import { S3CloudBackupClient, WebDAVCloudBackupClient } from "./cloud-backup-remote";
import { fetchCallFromArgs } from "./cloud-backup-test-fixtures";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const snapshot = (id: string) => ({ kind: "renewlet-cloud-backup-snapshot", schemaVersion: 1, id, filename: `${id}.zip`, createdAt: "2026-09-08T08:00:00.000Z", sizeBytes: 100, sha256: "a".repeat(64), exportKind: "renewlet-export", exportSchemaVersion: 1 });

describe("bounded remote backup pages", () => {
  it("uses S3 MaxKeys and continuation tokens and rejects a repeated cursor", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { href, method } = fetchCallFromArgs(input, init);
      calls.push(`${method} ${href}`);
      const url = new URL(href);
      if (url.searchParams.has("list-type")) {
        expect(url.searchParams.get("max-keys")).toBe("4");
        const cursor = url.searchParams.get("continuation-token");
        const keys = cursor ? ["later.manifest.json", "later.zip"] : ["first.manifest.json", "first.zip", "second.manifest.json", "second.zip"];
        return new Response(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next-page</NextContinuationToken>${keys.map((key) => `<Contents><Key>backups/${key}</Key></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
      }
      return Response.json(snapshot(url.pathname.split("/").at(-1)?.replace(".manifest.json", "") ?? ""));
    }));
    const client = new S3CloudBackupClient({ endpoint: "https://s3.example.test", region: "auto", bucket: "bucket", prefix: "backups", addressingStyle: "pathStyle", accessKeyId: "fixture" }, "fixture");
    const page = await client.listPage(null, 4);
    expect(page.manifests.map((item) => item.id)).toEqual(["first", "second"]);
    expect(page.cursor).toBe("next-page");
    expect(calls).toHaveLength(3);
    await expect(client.listPage(page.cursor, 4)).rejects.toMatchObject({ code: "CLOUD_BACKUP_S3_LIST_FAILED" });
    expect(calls).toHaveLength(4);
  });

  it("reads only the next WebDAV manifest page and creates at most four directory segments", async () => {
    const calls: string[] = [];
    const names = Array.from({ length: 10 }, (_, index) => `snapshot-${index}.manifest.json`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { href, method } = fetchCallFromArgs(input, init);
      calls.push(`${method} ${href}`);
      if (method === "MKCOL") return new Response(null, { status: 201 });
      if (method === "PROPFIND") {
        return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${names.map((name) => `<d:response><d:href>/a/b/c/d/e/f/${name}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype/><d:getcontentlength>100</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`, { status: 207 });
      }
      return Response.json(snapshot(new URL(href).pathname.split("/").at(-1)?.replace(".manifest.json", "") ?? ""));
    }));
    const client = new WebDAVCloudBackupClient({ url: "https://dav.example.test/", username: "fixture", path: "a/b/c/d/e/f" }, "fixture");
    const nextDirectory = await client.prepareDirectory(null, 4);
    expect(nextDirectory).toBe("a/b/c/d");
    expect(calls).toHaveLength(4);
    expect(await client.prepareDirectory(nextDirectory, 4)).toBeNull();
    expect(calls).toHaveLength(6);
    const page = await client.listPage("snapshot-3.manifest.json", 4);
    expect(page.manifests.map((item) => item.id)).toEqual(["snapshot-4", "snapshot-5", "snapshot-6", "snapshot-7"]);
    expect(page.cursor).toBe("snapshot-7.manifest.json");
    expect(calls).toHaveLength(11);
    const last = await client.listPage(page.cursor, 4);
    expect(last.manifests.map((item) => item.id)).toEqual(["snapshot-8", "snapshot-9"]);
    expect(last.cursor).toBeNull();
    expect(calls).toHaveLength(14);
  });
});
