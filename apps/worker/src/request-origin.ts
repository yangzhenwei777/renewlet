/** Worker 收到的 request.url 已是 Cloudflare 边缘外部 URL；不要让客户端伪造的 X-Forwarded-* 改写分享链接。 */
export function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}
