import { vi } from "vitest";

export function fetchCallFromArgs(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  return {
    href: input instanceof URL ? input.toString() : request?.url ?? String(input),
    method: init?.method ?? request?.method ?? "GET",
    headers: new Headers(init?.headers ?? request?.headers),
  };
}

export function stubRemoteSuccessFetch(): string[] {
  const calls: string[] = [];
  const webDavFileSizes = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const { href, method } = fetchCallFromArgs(url, init);
    calls.push(`${method} ${href}`);
    if (method === "MKCOL") return new Response("", { status: 201 });
    if (method === "PROPFIND" && href.includes("dav.example.com")) {
      const path = new URL(href).pathname;
      const isBackupDirectory = path.endsWith("/") || path.endsWith("/remote.php/dav/files/alice/renewlet");
      return new Response(isBackupDirectory
        ? emptyWebDAVMultiStatus()
        : webDAVFileMultiStatus(path, webDavFileSizes.get(path) ?? 0), { status: 207 });
    }
    if (href.includes("list-type=2")) return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, { status: 200 });
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "PUT" && href.includes("dav.example.com")) {
      const request = url instanceof Request ? url : new Request(url, init);
      webDavFileSizes.set(new URL(href).pathname, (await request.arrayBuffer()).byteLength);
    }
    return new Response("", { status: 200 });
  }));
  return calls;
}

// WebDAV SDK 会解析 PROPFIND 结构而不是正则捞 href；成功 fixture 必须像真实服务一样返回 collection propstat。
export function emptyWebDAVMultiStatus(): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice/renewlet/</d:href><d:propstat><d:prop><d:displayname>renewlet</d:displayname><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength><d:getlastmodified>Wed, 10 Jun 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
}

function webDAVFileMultiStatus(filename: string, size: number): string {
  const displayName = filename.split("/").filter(Boolean).pop() ?? "snapshot.zip";
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${filename}</d:href><d:propstat><d:prop><d:displayname>${displayName}</d:displayname><d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Wed, 10 Jun 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
}
