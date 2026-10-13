import type { CloudBackupSnapshotManifest } from "@renewlet/shared/schemas/cloud-backup";
import { CloudBackupRemoteError, S3CloudBackupClient } from "../../apps/worker/src/cloud-backup-remote";
import { createStoredZipFromSources } from "../../apps/worker/src/zip-store";

// 由 Wrangler 打包后在独立 workerd 中执行；只替换远端响应，SDK 入口、签名和 XML 解析仍走实际构建路径。
export default {
  async fetch(request: Request): Promise<Response> {
    const scenario = new URL(request.url).searchParams.get("scenario");
    if (scenario === "zip") {
      const date = new Date("2026-10-09T00:00:00.000Z");
      const payload = new Uint8Array(2 * 1024 * 1024);
      for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 17) & 255;
      const archive = await createStoredZipFromSources([
        { name: "assets/fixture-0.bin", size: payload.length, load: async () => payload },
      ], date, 16 * 1024 * 1024);
      return new Response(archive, { headers: { "content-type": "application/zip" } });
    }
    const prefix = scenario === "pages" ? "backups/" : "";
    const uploadScenario = scenario === "upload" || scenario === "head-forbidden" || scenario === "manifest-forbidden";
    const content = new TextEncoder().encode("backup-content");
    const id = "renewlet-export-v1-20261004T182855Z-4c43d1e5";
    const manifest: CloudBackupSnapshotManifest = {
      kind: "renewlet-cloud-backup-snapshot",
      schemaVersion: 1,
      id,
      filename: `${id}.zip`,
      createdAt: "2026-10-04T18:28:55.000Z",
      sizeBytes: content.byteLength,
      sha256: "a".repeat(64),
      exportKind: "renewlet-export",
      exportSchemaVersion: 1,
    };
    const objects = new Map<string, ArrayBuffer>();
    const calls: Array<{ method: string; path: string; cache: string; signed: boolean; prefix: string | null; maxKeys: string | null; token: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const target = new URL(outgoing.url);
      calls.push({
        method: outgoing.method,
        path: target.pathname,
        cache: outgoing.cache ?? "default",
        signed: outgoing.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ") ?? false,
        prefix: target.searchParams.get("prefix"),
        maxKeys: target.searchParams.get("max-keys"),
        token: target.searchParams.get("continuation-token"),
      });
      if (uploadScenario) {
        if (outgoing.method === "PUT") {
          objects.set(target.pathname, await outgoing.arrayBuffer());
          if (scenario === "manifest-forbidden" && target.pathname.endsWith(".manifest.json")) {
            return new Response("<Error><Code>AccessDenied</Code><Message>Manifest rejected</Message></Error>", { status: 403 });
          }
          return new Response(null, { status: 200 });
        }
        if (outgoing.method === "HEAD") {
          if (scenario === "head-forbidden") return new Response(null, { status: 403, headers: { "x-amz-request-id": "head-request" } });
          return new Response(null, { headers: { "content-length": String(objects.get(target.pathname)?.byteLength) } });
        }
        if (outgoing.method === "GET") return new Response(objects.get(target.pathname) ?? null);
        if (outgoing.method === "DELETE") {
          objects.delete(target.pathname);
          return new Response(null, { status: 204 });
        }
      }
      if (target.searchParams.has("list-type")) {
        if (scenario === "forbidden") {
          return new Response("<Error><Code>AccessDenied</Code><Message>Missing list permission</Message></Error>", {
            status: 403,
            headers: { "content-type": "application/xml", "x-amz-request-id": "forbidden-request" },
          });
        }
        if (scenario === "invalid-xml") return new Response("not xml", { headers: { "content-type": "application/xml" } });
        const firstPage = scenario === "pages" && !target.searchParams.has("continuation-token");
        return new Response(`<?xml version='1.0' encoding='utf-8'?>
          <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>backup-test</Name><EncodingType>url</EncodingType><Prefix>${prefix}</Prefix>
            <StartAfter/><ContinuationToken/><KeyCount>${firstPage ? 0 : 2}</KeyCount><MaxKeys>1000</MaxKeys>
            <IsTruncated>${firstPage}</IsTruncated>
            ${firstPage ? "<NextContinuationToken>next-page</NextContinuationToken>" : `
              <Contents><Key>${prefix}${id}.manifest.json</Key><Size>399</Size><ETag>&quot;manifest-etag&quot;</ETag>
                <Owner><ID>test-owner</ID><DisplayName>test-owner</DisplayName></Owner><StorageClass>STANDARD</StorageClass></Contents>
              <Contents><Key>${prefix}${id}.zip</Key><Size>261653</Size></Contents>`}
          </ListBucketResult>`, { headers: { "content-type": "application/xml" } });
      }
      if (target.pathname.endsWith(`${id}.manifest.json`)) return Response.json(manifest);
      throw new Error(`Unexpected S3 operation: ${target.pathname}`);
    };
    try {
      const client = new S3CloudBackupClient({
        endpoint: "https://storage.example.com",
        bucket: "backup-test",
        region: "us-east-1",
        prefix: prefix.replace(/\/$/, ""),
        addressingStyle: "auto",
        accessKeyId: "test-access",
      }, "test-secret");
      if (uploadScenario) {
        await client.upload(manifest.filename, content, manifest);
        const downloaded = await client.download(id);
        await client.delete(id);
        return Response.json({ content: new TextDecoder().decode(downloaded.content), calls, remainingObjects: objects.size });
      }
      return Response.json({ snapshots: await client.list(), calls });
    } catch (error) {
      if (!(error instanceof CloudBackupRemoteError)) throw error;
      return Response.json({ code: error.code, details: error.details, calls, remainingObjects: objects.size }, { status: 400 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
