import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS } from "@renewlet/shared/schemas/cloud-backup";
import { CloudBackupRemoteError, S3CloudBackupClient, WebDAVCloudBackupClient, sha256Hex } from "./cloud-backup-remote";

type CloudBackupRemoteErrorMatch = Omit<Partial<CloudBackupRemoteError>, "details"> & {
  details?: Partial<NonNullable<CloudBackupRemoteError["details"]>>;
};

// Worker 远端测试锁定 S3 签名输入和 raw response 契约，避免靠供应商域名表逐个打补丁。
function fetchCallFromArgs(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const href = input instanceof URL ? input.toString() : request?.url ?? String(input);
  return {
    href,
    url: new URL(href),
    method: init?.method ?? request?.method ?? "GET",
    cache: init?.cache ?? request?.cache,
    headers: new Headers(init?.headers ?? request?.headers),
  };
}

function s3Client(endpoint: string, bucket: string, addressingStyle: "auto" | "pathStyle" | "virtualHost" = "auto"): S3CloudBackupClient {
  return s3ClientWithRegion(endpoint, bucket, "ap-shanghai", "snapshots", addressingStyle);
}

function s3ClientWithRegion(endpoint: string, bucket: string, region: string, prefix = "snapshots", addressingStyle: "auto" | "pathStyle" | "virtualHost" = "auto"): S3CloudBackupClient {
  return new S3CloudBackupClient({
    endpoint,
    region,
    bucket,
    prefix,
    addressingStyle,
    accessKeyId: "access-key",
  }, "secret-key");
}

function stubS3ListSuccess(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const { href, method, cache } = fetchCallFromArgs(url, init);
    expect(cache).toBe("no-store");
    calls.push(`${method} ${href}`);
    return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, { status: 200 });
  }));
  return calls;
}

describe("S3CloudBackupClient endpoint addressing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses ListObjectsV2 XML without DOMParser in the Node SDK entry", async () => {
    vi.stubGlobal("DOMParser", undefined);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href, method } = fetchCallFromArgs(url, init);
      calls.push(`${method} ${href}`);
      return new Response([
        `<?xml version="1.0"?>`,
        `<ListBucketResult>`,
        `<Contents><Key>snapshots%2Frenewlet-export-v1-20260609T000000Z-abcd1234.zip</Key></Contents>`,
        `</ListBucketResult>`,
      ].join(""), { status: 200 });
    }));

    await s3Client("https://storage.example.com", "renewlet").list();

    expect(calls[0]).toContain("list-type=2");
    expect(calls[0]).toContain("encoding-type=url");
  });

  it("uses virtual-hosted addressing for standard service endpoints", async () => {
    const calls = stubS3ListSuccess();

    await s3Client("https://storage.example.com", "renewlet").list();

    expect(calls.some((call) => call.includes("https://renewlet.storage.example.com/") && call.includes("list-type=2"))).toBe(true);
    expect(calls.every((call) => !call.includes("https://storage.example.com/renewlet"))).toBe(true);
  });

  it("omits ListObjectsV2 Prefix for an explicit bucket-root configuration", async () => {
    const calls = stubS3ListSuccess();

    await s3ClientWithRegion("https://storage.example.com", "renewlet", "auto", "").list();

    expect(calls[0]).toContain("https://renewlet.storage.example.com/");
    expect(calls[0]).not.toContain("prefix=");
  });

  it("uses path-style addressing only when explicitly selected", async () => {
    const calls = stubS3ListSuccess();

    await s3Client("https://storage.example.com:9000", "renewlet", "pathStyle").list();

    expect(calls.some((call) => call.includes("https://storage.example.com:9000/renewlet") && call.includes("list-type=2"))).toBe(true);
    expect(calls.every((call) => !call.includes("https://renewlet.storage.example.com:9000"))).toBe(true);
  });

  it("uses the explicit signing region in SigV4 credential scope", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href, method, headers } = fetchCallFromArgs(url, init);
      expect(headers.get("authorization")).toContain("/auto/s3/aws4_request");
      calls.push(`${method} ${href}`);
      return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, { status: 200 });
    }));

    await s3ClientWithRegion("https://storage.example.com", "renewlet", "auto").list();

    expect(calls[0]).toContain("https://renewlet.storage.example.com/");
  });

  it.each(["SignatureDoesNotMatch", "Unknown"])("preserves an actual %s provider response without filtering error names", async (providerCode) => {
    const body = `<?xml version='1.0' encoding='utf-8'?><Error><Code>${providerCode}</Code><Message>provider failure</Message></Error>`;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { headers } = fetchCallFromArgs(url, init);
      expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
      return new Response(body, {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/xml", server: "s3-compatible" },
      });
    }));

    let error: CloudBackupRemoteError | null = null;
    try {
      await s3ClientWithRegion("https://storage.example.com", "renewlet", "auto").list();
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }

    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_S3_LIST_FAILED",
      details: {
        providerCode,
        providerMessage: body,
        httpStatus: 403,
        httpStatusText: "Forbidden",
        requiredCapability: "bucket listing permission",
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(error?.details?.clientMessage).toBeUndefined();
    expect(JSON.stringify(error?.details)).not.toContain("X-Amz-Signature");
  });

  it("returns provider response when ListObjectsV2 returns invalid XML with 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`not xml`, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/xml" },
    })));

    let error: CloudBackupRemoteError | null = null;
    try {
      await s3Client("https://storage.example.com", "renewlet").list();
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }

    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_S3_LIST_FAILED",
      details: {
        providerMessage: expect.any(String),
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(error?.details?.operation).toBe("ListObjectsV2");
    expect(error?.details?.clientMessage).toContain("XML parse error");
    expect(error?.details?.providerCode).toBeUndefined();
  });

  it.each([200, 403])("bounds an oversized S3 response with HTTP %s and cancels its stream", async (status) => {
    const cancel = vi.fn();
    const limit = status === 200 ? 1024 * 1024 : CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS;
    const body = `<Error><Code>AccessDenied</Code><Message>secret-key ${"x".repeat(limit)}</Message></Error>`;
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
      cancel,
    }), { status }));
    vi.stubGlobal("fetch", fetch);

    const error: unknown = await s3Client("https://storage.example.com", "renewlet").list().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudBackupRemoteError);
    if (!(error instanceof CloudBackupRemoteError)) throw new Error("Expected structured remote error");
    expect(error.code).toBe("CLOUD_BACKUP_S3_LIST_FAILED");
    expect(error.details?.httpStatus).toBe(status);
    expect(error.details?.providerMessage?.length).toBeLessThanOrEqual(CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS);
    expect(JSON.stringify(error.details)).not.toContain("secret-key");
    if (status === 200) expect(error.details?.clientMessage).toContain("1048576-byte limit");
    else expect(error.details?.providerCode).toBe("AccessDenied");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps a local SDK exception separate from a successful provider response", async () => {
    const body = "<ListBucketResult><Name>renewlet</Name></ListBucketResult>";
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(Object.assign(
      new ReferenceError("DOMParser is not defined; access-key secret-key https://storage.example.com/?X-Amz-Signature=hidden"),
      {
        $metadata: { httpStatusCode: 200, requestId: "request-id" },
        $response: { statusCode: 200, body },
      },
    ));

    const error = await s3Client("https://storage.example.com", "renewlet").list().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_S3_LIST_FAILED",
      details: {
        httpStatus: 200,
        requestId: "request-id",
        providerMessage: body,
        clientMessage: expect.stringContaining("ReferenceError: DOMParser is not defined"),
      },
    });

    expect(error).toBeInstanceOf(CloudBackupRemoteError);
    if (!(error instanceof CloudBackupRemoteError)) throw new Error("Expected structured remote error");
    expect(error.details?.providerCode).toBeUndefined();
    expect(JSON.stringify(error.details)).not.toMatch(/access-key|secret-key|hidden/);
  });

  it("returns local S3 failures without leaking credentials or signatures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Network connection lost.");
    }));

    let error: CloudBackupRemoteError | null = null;
    try {
      await s3ClientWithRegion("https://iam.storage.dev", "cloudstorage", "auto").list();
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }

    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_S3_LIST_FAILED",
      details: {
        target: expect.stringContaining("host=iam.storage.dev; bucket=cloudstorage"),
      },
    } satisfies CloudBackupRemoteErrorMatch);
    const serialized = JSON.stringify(error?.details);
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).not.toContain("access-key");
    expect(serialized).not.toContain("secret-key");
  });

  it("follows pagination but stops on repeated continuation tokens", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href, url: parsedUrl } = fetchCallFromArgs(url, init);
      if (parsedUrl.searchParams.get("list-type") === "2") calls.push(href);
      const token = parsedUrl.searchParams.get("continuation-token");
      return new Response([
        `<?xml version="1.0"?>`,
        `<ListBucketResult>`,
        `<Contents><Key>${token ? "snapshots%2Fsecond.zip" : "snapshots%2Ffirst.zip"}</Key></Contents>`,
        `<NextContinuationToken>same-token</NextContinuationToken>`,
        `</ListBucketResult>`,
      ].join(""), { status: 200 });
    }));

    await s3ClientWithRegion("https://storage.example.com", "renewlet", "auto", "").list();

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("prefix=");
    expect(calls[1]).not.toContain("prefix=");
    expect(calls[1]).toContain("continuation-token=same-token");
  });

  it("preserves a bodyless HeadObject failure and cleanup without inventing provider diagnostics", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { method, cache } = fetchCallFromArgs(url, init);
      expect(cache).toBe("no-store");
      calls.push(method);
      if (method === "HEAD") return new Response(null, { status: 403, statusText: "Forbidden", headers: { "x-amz-request-id": "head-request" } });
      if (method === "DELETE") return new Response("", { status: 403, statusText: "Forbidden" });
      return new Response("", { status: 200 });
    }));

    const content = new TextEncoder().encode("renewlet");
    const manifest = {
      kind: "renewlet-cloud-backup-snapshot" as const,
      schemaVersion: 1 as const,
      id: "renewlet-export-v1-20260609T000000Z-head",
      filename: "renewlet-export-v1-20260609T000000Z-head.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: content.length,
      sha256: await sha256Hex(content),
      exportKind: "renewlet-export" as const,
      exportSchemaVersion: 1 as const,
    };
    let error: CloudBackupRemoteError | null = null;
    try {
      await s3Client("https://storage.example.com", "renewlet").upload(manifest.filename, content, manifest);
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }
    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_S3_HEAD_FAILED",
      details: {
        requiredCapability: "object read permission",
        httpStatus: 403,
        httpStatusText: "Forbidden",
        operation: "HeadObject",
        requestId: "head-request",
        cleanup: [expect.objectContaining({ operation: "DeleteObject", code: "CLOUD_BACKUP_S3_DELETE_FAILED" })],
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(error?.details?.providerCode).toBeUndefined();
    expect(error?.details?.providerMessage).toBeUndefined();
    expect(error?.details?.clientMessage).toBeUndefined();
    expect(calls).toEqual(["PUT", "HEAD", "DELETE"]);
  });

  it("removes both objects when manifest upload fails", async () => {
    const calls: string[] = [];
    let putCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { method } = fetchCallFromArgs(url, init);
      calls.push(method);
      if (method === "PUT" && ++putCount === 2) return new Response("", { status: 403, statusText: "Forbidden" });
      if (method === "HEAD") return new Response("", { status: 200, headers: { "content-length": "8" } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 200 });
    }));

    const content = new TextEncoder().encode("renewlet");
    const manifest = {
      kind: "renewlet-cloud-backup-snapshot" as const,
      schemaVersion: 1 as const,
      id: "renewlet-export-v1-20260609T000000Z-manifest",
      filename: "renewlet-export-v1-20260609T000000Z-manifest.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: content.length,
      sha256: await sha256Hex(content),
      exportKind: "renewlet-export" as const,
      exportSchemaVersion: 1 as const,
    };
    let error: CloudBackupRemoteError | null = null;
    try {
      await s3Client("https://storage.example.com", "renewlet").upload(manifest.filename, content, manifest);
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }
    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_S3_PUT_FAILED",
      details: {
        target: expect.stringContaining("snapshots/renewlet-export-v1-20260609T000000Z-manifest.manifest.json"),
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(calls).toEqual(["PUT", "HEAD", "PUT", "DELETE", "DELETE"]);
  });
});

function patchWebDAVFetch(handler: (request: Request) => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => await handler(new Request(input, init))));
}

function webDAVClient(): WebDAVCloudBackupClient {
  return new WebDAVCloudBackupClient({
    url: "https://dav.example.com/remote.php/dav/files/alice",
    username: "alice",
    path: "renewlet",
  }, "webdav-secret");
}

function installFakeWebDAVServer(): string[] {
  const calls: string[] = [];
  const directories = new Set(["/remote.php/dav/files/alice/"]);
  const files = new Map<string, Uint8Array>();
  patchWebDAVFetch(async (request) => {
    const url = new URL(request.url);
    const target = cleanWebDAVPath(url.pathname);
    calls.push(`${request.method} ${target}`);
    if (request.method === "MKCOL") {
      directories.add(target);
      return new Response("", { status: 201 });
    }
    if (request.method === "PROPFIND") {
      if (!directories.has(target)) {
        const body = files.get(target);
        if (!body) return new Response("", { status: 404, statusText: "Not Found" });
        return new Response(webDAVFileMultiStatus(target, body.length), {
          status: 207,
          statusText: "Multi-Status",
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response(webDAVMultiStatus(target, files), {
        status: 207,
        statusText: "Multi-Status",
        headers: { "content-type": "application/xml" },
      });
    }
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      files.set(target, bytes);
      return new Response("", { status: 201 });
    }
    if (request.method === "GET") {
      const body = files.get(target);
      return body ? new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, { status: 200 }) : new Response("", { status: 404, statusText: "Not Found" });
    }
    if (request.method === "DELETE") {
      const existed = files.delete(target);
      return new Response(existed ? null : "", { status: existed ? 204 : 404 });
    }
    return new Response("", { status: 405 });
  });
  return calls;
}

describe("WebDAVCloudBackupClient protocol adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs probe, upload, list, download and delete through Worker fetch", async () => {
    const calls = installFakeWebDAVServer();
    const client = webDAVClient();
    const content = new TextEncoder().encode("renewlet");
    const manifest = {
      kind: "renewlet-cloud-backup-snapshot" as const,
      schemaVersion: 1 as const,
      id: "renewlet-export-v1-20260609T000000Z-webdav",
      filename: "renewlet-export-v1-20260609T000000Z-webdav.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: content.length,
      sha256: await sha256Hex(content),
      exportKind: "renewlet-export" as const,
      exportSchemaVersion: 1 as const,
    };

    await client.test();
    await client.upload(manifest.filename, content, manifest);
    await expect(client.list()).resolves.toMatchObject([{ id: manifest.id }]);
    await expect(client.download(manifest.id)).resolves.toMatchObject({ manifest: { id: manifest.id } });
    await client.delete(manifest.id);

    for (const method of ["MKCOL", "PROPFIND", "PUT", "GET", "DELETE"]) {
      expect(calls.some((call) => call.startsWith(method))).toBe(true);
    }
  });

  it("returns a complete provider response for empty WebDAV 401 responses", async () => {
    patchWebDAVFetch(() => new Response("", {
      status: 401,
      statusText: "Unauthorized",
      headers: { server: "fake-webdav", authorization: "Basic webdav-secret" },
    }));

    let error: CloudBackupRemoteError | null = null;
    try {
      await webDAVClient().list();
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }

    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_WEBDAV_MKCOL_FAILED",
      details: {
        httpStatus: 401,
        httpStatusText: "Unauthorized",
        requiredCapability: "object write permission",
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(JSON.stringify(error?.details)).not.toContain("webdav-secret");
  });

  it("returns redacted WebDAV XML body and attempted host for local errors", async () => {
    const xml = `<d:error xmlns:d="DAV:"><d:message>denied webdav-secret</d:message></d:error>`;
    patchWebDAVFetch(() => new Response(xml, {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/xml" },
    }));

    let remoteError: CloudBackupRemoteError | null = null;
    try {
      await webDAVClient().list();
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) remoteError = caught;
      else throw caught;
    }

    expect(remoteError?.details?.providerMessage).toContain("denied [redacted]");
    expect(remoteError?.details?.httpStatus).toBe(403);
    expect(remoteError?.details?.requiredCapability).toBe("object write permission");
    patchWebDAVFetch(() => {
      throw new TypeError("Network connection lost.");
    });

    let localError: CloudBackupRemoteError | null = null;
    try {
      await webDAVClient().list();
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) localError = caught;
      else throw caught;
    }
    expect(localError).toMatchObject({
      code: "CLOUD_BACKUP_WEBDAV_MKCOL_FAILED",
      details: {
        target: expect.stringContaining("host=dav.example.com"),
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(JSON.stringify(localError?.details)).not.toContain("webdav-secret");
  });

  it("cleans the ZIP and manifest after a WebDAV manifest upload failure", async () => {
    const calls: string[] = [];
    let putCount = 0;
    const files = new Map<string, Uint8Array>();
    patchWebDAVFetch(async (request) => {
      const target = cleanWebDAVPath(new URL(request.url).pathname);
      calls.push(`${request.method} ${target}`);
      if (request.method === "MKCOL") return new Response("", { status: 201 });
      if (request.method === "PUT" && ++putCount === 2) return new Response("", { status: 403, statusText: "Forbidden" });
      if (request.method === "PUT") {
        files.set(target, new Uint8Array(await request.arrayBuffer()));
        return new Response("", { status: 201 });
      }
      if (request.method === "PROPFIND" && files.has(target)) return new Response(webDAVFileMultiStatus(target, files.get(target)?.byteLength ?? 0), { status: 207, headers: { "content-type": "application/xml" } });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 404, statusText: "Not Found" });
    });

    const content = new TextEncoder().encode("renewlet");
    const manifest = {
      kind: "renewlet-cloud-backup-snapshot" as const,
      schemaVersion: 1 as const,
      id: "renewlet-export-v1-20260609T000000Z-webdav-failure",
      filename: "renewlet-export-v1-20260609T000000Z-webdav-failure.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: content.length,
      sha256: await sha256Hex(content),
      exportKind: "renewlet-export" as const,
      exportSchemaVersion: 1 as const,
    };

    await expect(webDAVClient().upload(manifest.filename, content, manifest)).rejects.toMatchObject({
      code: "CLOUD_BACKUP_WEBDAV_PUT_FAILED",
      details: {
        httpStatus: 403,
        httpStatusText: "Forbidden",
      },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(calls.filter((call) => call.startsWith("PUT "))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(2);
  });

  it("cleans the ZIP when WebDAV stat validation is forbidden", async () => {
    const calls: string[] = [];
    let putStarted = false;
    patchWebDAVFetch(async (request) => {
      calls.push(request.method);
      if (request.method === "MKCOL" || request.method === "PUT") {
        putStarted = request.method === "PUT";
        return new Response("", { status: 201 });
      }
      if (request.method === "PROPFIND") return new Response("", { status: putStarted ? 403 : 404, statusText: putStarted ? "Forbidden" : "Not Found" });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 404, statusText: "Not Found" });
    });

    const content = new TextEncoder().encode("renewlet");
    const manifest = {
      kind: "renewlet-cloud-backup-snapshot" as const,
      schemaVersion: 1 as const,
      id: "renewlet-export-v1-20260609T000000Z-webdav-stat",
      filename: "renewlet-export-v1-20260609T000000Z-webdav-stat.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: content.length,
      sha256: await sha256Hex(content),
      exportKind: "renewlet-export" as const,
      exportSchemaVersion: 1 as const,
    };

    await expect(webDAVClient().upload(manifest.filename, content, manifest)).rejects.toMatchObject({
      code: "CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED",
      details: { requiredCapability: "bucket listing permission", httpStatus: 403 },
    } satisfies CloudBackupRemoteErrorMatch);
    expect(calls).toEqual(["PROPFIND", "MKCOL", "PUT", "PROPFIND", "DELETE"]);
  });

  it("switches from Basic to Digest after an explicit WebDAV challenge", async () => {
    const authorizations: string[] = [];
    patchWebDAVFetch((request) => {
      const authorization = request.headers.get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorization.startsWith("Basic ")) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": 'Digest realm="renewlet", nonce="nonce-value", algorithm=MD5, qop="auth"',
          },
        });
      }
      return new Response(webDAVMultiStatus("/remote.php/dav/files/alice/renewlet/", new Map()), {
        status: 207,
        headers: { "content-type": "application/xml" },
      });
    });

    await expect(webDAVClient().list()).resolves.toEqual([]);

    expect(authorizations[0]).toMatch(/^Basic /);
    expect(authorizations.some((value) => value.startsWith("Digest "))).toBe(true);
    expect(authorizations.join(" ")).not.toContain("webdav-secret");
  });
});

function cleanWebDAVPath(value: string): string {
  const path = `/${value.split("/").filter(Boolean).join("/")}`;
  if (path.split("/").pop()?.includes(".")) return path;
  return path.endsWith("/") ? path : `${path}/`;
}

function webDAVMultiStatus(directory: string, files: Map<string, Uint8Array>): string {
  const responses = [webDAVResponse(directory, true, 0)];
  for (const [filename, body] of files) {
    if (`${filename.split("/").slice(0, -1).join("/")}/` === directory) {
      responses.push(webDAVResponse(filename, false, body.length));
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;
}

function webDAVFileMultiStatus(filename: string, size: number): string {
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${webDAVResponse(filename, false, size)}</d:multistatus>`;
}

function webDAVResponse(href: string, directory: boolean, size: number): string {
  const displayName = href.split("/").filter(Boolean).pop() ?? "";
  const resourceType = directory ? `<d:resourcetype><d:collection/></d:resourcetype>` : `<d:resourcetype/>`;
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${displayName}</d:displayname>${resourceType}<d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Wed, 10 Jun 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
