import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudBackupRemoteError, S3CloudBackupClient, WebDAVCloudBackupClient, sha256Hex } from "./cloud-backup-remote";

// Worker 远端测试锁定 S3 签名输入和 raw response 契约，避免靠供应商域名表逐个打补丁。
function fetchCallFromArgs(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const href = input instanceof URL ? input.toString() : request?.url ?? String(input);
  return {
    href,
    url: new URL(href),
    method: init?.method ?? request?.method ?? "GET",
    headers: new Headers(init?.headers ?? request?.headers),
  };
}

function s3Client(endpoint: string, bucket: string): S3CloudBackupClient {
  return s3ClientWithRegion(endpoint, bucket, "ap-shanghai");
}

function s3ClientWithRegion(endpoint: string, bucket: string, region: string): S3CloudBackupClient {
  return new S3CloudBackupClient({
    endpoint,
    region,
    bucket,
    prefix: "snapshots",
    accessKeyId: "access-key",
  }, "secret-key");
}

function stubS3ListSuccess(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const { href, method } = fetchCallFromArgs(url, init);
    calls.push(`${method} ${href}`);
    return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, { status: 200 });
  }));
  return calls;
}

describe("S3CloudBackupClient endpoint addressing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses ListObjectsV2 XML without DOMParser in the Worker runtime path", async () => {
    vi.stubGlobal("DOMParser", undefined);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href, method } = fetchCallFromArgs(url, init);
      calls.push(`${method} ${href}`);
      return new Response([
        `<?xml version="1.0"?>`,
        `<ListBucketResult>`,
        `<Contents><Key>snapshots%2Frenewlet-export-v1-20260609T000000Z-abcd1234.manifest.json</Key></Contents>`,
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

  it("uses path-style addressing only for local network shaped endpoints", async () => {
    const calls = stubS3ListSuccess();

    await s3Client("https://storage.example.com:9000", "renewlet").list();

    expect(calls.some((call) => call.includes("https://storage.example.com:9000/renewlet") && call.includes("list-type=2"))).toBe(true);
    expect(calls.every((call) => !call.includes("https://renewlet.storage.example.com:9000"))).toBe(true);
  });

  it("uses the explicit signing region in SigV4 credential scope", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href, method, url: parsedUrl } = fetchCallFromArgs(url, init);
      expect(parsedUrl.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
      calls.push(`${method} ${href}`);
      return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, { status: 200 });
    }));

    await s3ClientWithRegion("https://storage.example.com", "renewlet", "auto").list();

    expect(calls[0]).toContain("https://renewlet.storage.example.com/");
  });

  it("returns upstream XML for signature failures without leaking signed query values", async () => {
    const body = `<?xml version='1.0' encoding='utf-8'?><Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>`;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { url: parsedUrl } = fetchCallFromArgs(url, init);
      expect(parsedUrl.searchParams.get("X-Amz-Signature")).toBeTruthy();
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
        rawResponseText: expect.stringContaining("<Code>SignatureDoesNotMatch</Code>"),
      },
    } satisfies Partial<CloudBackupRemoteError>);
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
        rawResponseText: expect.any(String),
      },
    } satisfies Partial<CloudBackupRemoteError>);
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
      code: "CLOUD_BACKUP_S3_LOCAL_FAILED",
      details: {
        rawResponseText: expect.stringContaining("S3 ListObjectsV2 GET request to https://cloudstorage.iam.storage.dev/"),
      },
    } satisfies Partial<CloudBackupRemoteError>);
    const serialized = JSON.stringify(error?.details);
    expect(serialized).toContain("X-Amz-Signature=%5Bredacted%5D");
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
        `<Contents><Key>${token ? "snapshots%2Fsecond.manifest.json" : "snapshots%2Ffirst.manifest.json"}</Key></Contents>`,
        `<NextContinuationToken>same-token</NextContinuationToken>`,
        `</ListBucketResult>`,
      ].join(""), { status: 200 });
    }));

    await s3Client("https://storage.example.com", "renewlet").list();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("continuation-token=same-token");
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
      if (!directories.has(target)) return new Response("", { status: 404, statusText: "Not Found" });
      return new Response(webDAVMultiStatus(target, files), {
        status: 207,
        statusText: "Multi-Status",
        headers: { "content-type": "application/xml" },
      });
    }
    if (request.method === "PUT") {
      files.set(target, new Uint8Array(await request.arrayBuffer()));
      return new Response("", { status: 201 });
    }
    if (request.method === "GET") {
      const body = files.get(target);
      return body ? new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, { status: 200 }) : new Response("", { status: 404, statusText: "Not Found" });
    }
    if (request.method === "DELETE") {
      const existed = files.delete(target);
      return new Response("", { status: existed ? 204 : 404 });
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
        rawResponseText: expect.any(String),
      },
    } satisfies Partial<CloudBackupRemoteError>);
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

    expect(remoteError?.details?.rawResponseText).toContain("denied [redacted]");
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
        rawResponseText: expect.stringContaining("WebDAV PROPFIND request to https://dav.example.com/remote.php/dav/files/alice/renewlet"),
      },
    } satisfies Partial<CloudBackupRemoteError>);
    expect(JSON.stringify(localError?.details)).not.toContain("webdav-secret");
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
    expect(authorizations.slice(1).every((value) => value.startsWith("Digest "))).toBe(true);
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

function webDAVResponse(href: string, directory: boolean, size: number): string {
  const displayName = href.split("/").filter(Boolean).pop() ?? "";
  const resourceType = directory ? `<d:resourcetype><d:collection/></d:resourcetype>` : `<d:resourcetype/>`;
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${displayName}</d:displayname>${resourceType}<d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Wed, 10 Jun 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
