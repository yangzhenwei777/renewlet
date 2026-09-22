import { serverText } from "./server-i18n";
import type { AppLocale } from "./http";
import { sendUpstreamRequest } from "./upstream-http";

type OutboundResolver = (hostname: string) => Promise<string[]>;
type Ipv4Octets = [number, number, number, number];

const DNS_JSON_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_JSON_TIMEOUT_MS = 5_000;
const LOCAL_HOSTNAMES = new Set(["localhost"]);

/**
 * assertSafeOutboundUrl 保护通知 Webhook 等用户配置外链。
 *
 * Worker 需要主动请求这些 URL，因此必须同时限制 HTTPS、凭据 URL、本地域名和解析到内网/保留网段的地址。
 */
export async function assertSafeOutboundUrl(raw: string, locale: AppLocale, resolveHost: OutboundResolver = resolveHostViaDoh): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(serverText(locale, "url.invalidGeneric"));
  }
  if (url.protocol !== "https:") throw new Error(serverText(locale, "url.mustUseHttpsGeneric"));
  if (url.username || url.password) throw new Error(serverText(locale, "url.invalidGeneric"));

  const hostname = url.hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new Error(serverText(locale, "url.privateOrLocalNotAllowedGeneric"));
  }

  const literal = parseIpLiteral(hostname);
  const resolved = literal ? [literal] : await resolveHost(hostname);
  if (resolved.length === 0 || resolved.some(isUnsafeOutboundIp)) {
    throw new Error(serverText(locale, "url.privateOrLocalNotAllowedGeneric"));
  }
  return url;
}

export function isUnsafeOutboundHostLiteral(hostname: string): boolean {
  const literal = parseIpLiteral(hostname.toLowerCase());
  return literal ? isUnsafeOutboundIp(literal) : false;
}

async function resolveHostViaDoh(hostname: string): Promise<string[]> {
  // Workers 没有 Node DNS API；用 Cloudflare DoH 同时查 A/AAAA，避免只检查字面 hostname 而漏掉内网解析。
  const results = await Promise.all(["A", "AAAA"].map(async (type) => {
    const url = new URL(DNS_JSON_ENDPOINT);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await sendUpstreamRequest(url, { headers: { accept: "application/dns-json" } }, {
      provider: "Cloudflare DNS",
      timeoutMs: DNS_JSON_TIMEOUT_MS,
    });
    if (!response.ok) return [];
    const payload = await response.json() as { Answer?: Array<{ data?: string }> };
    return (payload.Answer ?? [])
      .map((answer) => parseIpLiteral(answer.data ?? ""))
      .filter((value): value is string => value !== null);
  }));
  return results.flat();
}

function parseIpLiteral(value: string): string | null {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = parseIpv4Literal(normalized);
  if (ipv4) return ipv4.join(".");
  if (normalized.includes(":")) return normalized;
  return null;
}

function parseIpv4Literal(value: string): Ipv4Octets | null {
  const dotted = value.split(".");
  if (dotted.length === 4) {
    const octets = dotted.map(parseIpv4Part);
    if (isIpv4Octets(octets)) return octets;
    return null;
  }
  const whole = parseIpv4Part(value);
  if (whole === null || whole > 0xffffffff) return null;
  return [
    (whole >>> 24) & 0xff,
    (whole >>> 16) & 0xff,
    (whole >>> 8) & 0xff,
    whole & 0xff,
  ];
}

function parseIpv4Part(value: string): number | null {
  // 浏览器/URL 解析可能接受十六进制、八进制或整数 IPv4；SSRF 防护必须先规范化再判断网段。
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  if (/^0[0-7]+$/.test(value)) return Number.parseInt(value.slice(1), 8);
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function isIpv4Octets(value: Array<number | null>): value is Ipv4Octets {
  return value.length === 4 && value.every((part) => part !== null && part <= 255);
}

function isUnsafeOutboundIp(value: string): boolean {
  const ipv4 = parseIpv4Literal(value);
  if (ipv4) return isUnsafeIpv4(ipv4);
  return isUnsafeIpv6(value);
}

function isUnsafeIpv4([a, b]: Ipv4Octets): boolean {
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isUnsafeIpv6(value: string): boolean {
  const ip = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;
  const mapped = parseIpv4MappedIpv6(ip);
  if (mapped) return isUnsafeIpv4(mapped);
  return false;
}

function parseIpv4MappedIpv6(value: string): Ipv4Octets | null {
  if (!value.startsWith("::ffff:")) return null;
  const suffix = value.slice("::ffff:".length);
  const dotted = parseIpv4Literal(suffix);
  if (dotted) return dotted;
  // URL 会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1；这里还原后再走 IPv4 私网判断。
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;
  const words = parts.map((part) => Number.parseInt(part, 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  const firstWord = words[0];
  const secondWord = words[1];
  if (firstWord === undefined || secondWord === undefined) return null;
  return [
    (firstWord >>> 8) & 0xff,
    firstWord & 0xff,
    (secondWord >>> 8) & 0xff,
    secondWord & 0xff,
  ];
}
