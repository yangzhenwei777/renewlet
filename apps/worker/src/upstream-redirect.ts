// 与当前兼容日期的workerd保持一致；次数按整条链累计，不能在每跳重置。
export const UPSTREAM_MAX_REDIRECTS = 20;
export const UPSTREAM_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function upstreamRedirect(url: URL, location: string, status: number, method: string, streamingBody: boolean): { url: URL; method: string; dropBody: boolean } {
  let next: URL;
  try { next = new URL(location, url); } catch { throw new TypeError("Invalid upstream redirect URL"); }
  if ((next.protocol !== "https:" && next.protocol !== "http:") || next.username || next.password) throw new TypeError("Invalid upstream redirect URL");
  if (status !== 303 && streamingBody) throw new TypeError("Cannot redirect a streaming upstream body");
  const dropBody = ((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD");
  return { url: next, method: dropBody ? "GET" : method, dropBody };
}
