/**
 * Cloudflare 系统版本 handler 只提供只读部署状态。
 *
 * Worker 不能执行 Docker 式下载、替换二进制或重启；这里仍检查 GitHub Release，让前端能提示用户同步部署。
 */
import { systemUpdateOperationPayloadSchema, systemVersionPayloadSchema } from "@renewlet/shared/schemas/app";
import { XMLParser } from "fast-xml-parser";
import rootPackageJson from "../../../package.json";
import { requireAdmin, requireAuth } from "./auth";
import { HttpError, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import type { Env } from "./types";
import {
  UpstreamOperationError,
  createUpstreamErrorDetails,
  createUpstreamHTTPError,
  providerMessageFromResponse,
  readUpstreamResponseBody,
  upstreamErrorDetailsFromError,
  upstreamProviderResponseFromBody,
} from "./upstream-response";
import { sendUpstreamRequest } from "./upstream-http";

const DEV_VERSION = "0.0.0-dev";
const SYSTEM_RELEASE_FEED_URL = "https://github.com/zhiyingzzhou/renewlet/releases.atom";
const SYSTEM_RELEASE_FEED_LIMIT_BYTES = 512 * 1024;
const STABLE_BUILD_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BRANCH_BUILD_VERSION_PATTERN = /^\d+\.\d+\.\d+-dev\+[0-9a-f]{7,40}$/i;
const PLACEHOLDER_DEV_VERSION_PATTERN = /^0\.0\.0-dev(?:\+.*)?$/;
const STABLE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const COMPARABLE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
};

type SystemReleaseEntry = {
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
};

type AtomTextValue =
  | string
  | number
  | boolean
  | {
      "#text"?: unknown;
    };

type AtomLinkValue = {
  href?: unknown;
};

type AtomEntryValue = {
  title?: AtomTextValue;
  updated?: AtomTextValue;
  content?: AtomTextValue;
  link?: AtomLinkValue | AtomLinkValue[];
};

type AtomFeedValue = {
  feed?: {
    entry?: AtomEntryValue | AtomEntryValue[];
  };
};

const releaseFeedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
});

/**
 * systemVersion 返回 Cloudflare 运行面的版本状态。
 *
 * Worker 部署没有可替换的本地二进制，但仍应只读检查 GitHub Release，避免把“不能页面内执行更新”误当成“不能判断版本”。
 */
export async function systemVersion(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const locale = requestLocale(request);
  const commit = cloudflareBuildValue(env.RENEWLET_COMMIT, "");
  const buildTime = cloudflareBuildValue(env.RENEWLET_BUILD_TIME, "");
  const version = resolveCloudflareVersion(env.RENEWLET_VERSION);
  const releaseCheck = await checkLatestStableRelease(version, locale, env);
  const isAdmin = auth.user.role === "admin";
  return successJson(systemVersionPayloadSchema.parse({
    currentVersion: version,
    latestVersion: releaseCheck.latestVersion,
    hasUpdate: releaseCheck.hasUpdate,
    checkSucceeded: releaseCheck.checkSucceeded,
    deployment: "cloudflare",
    updateMode: "cloudflare-deploy",
    updateSupported: false,
    unsupportedReason: serverText(locale, "system.cloudflareVersionUnsupportedReason"),
    releaseInfo: releaseCheck.releaseInfo,
    cached: false,
    ...(releaseCheck.warning ? { warning: releaseCheck.warning } : {}),
    // 版本 badge 面向所有登录用户；GitHub raw response 仍只随管理员排障响应一次性回显。
    ...(isAdmin && releaseCheck.errorDetails ? { errorDetails: releaseCheck.errorDetails } : {}),
    build: {
      version,
      commit,
      buildTime,
      buildType: "cloudflare",
    },
  }));
}

/**
 * systemUpdate 明确拒绝 Cloudflare 页面内更新。
 *
 * Cloudflare 的发布入口是 Wrangler/Workers Builds，管理员按钮不能触发容器式下载、校验和重启状态机。
 */
export async function systemUpdate(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const locale = requestLocale(request);
  throw new HttpError(400, serverText(locale, "system.cloudflareUpdateUnsupported"), "SYSTEM_UPDATE_UNSUPPORTED");
}

/** Cloudflare 没有本地更新任务；保留同形状态端点，让跨运行面前端协议无需分叉。 */
export async function systemUpdateStatus(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  return successJson(systemUpdateOperationPayloadSchema.parse({ operation: null }));
}

/**
 * systemRestart 明确拒绝 Cloudflare 页面内重启。
 *
 * Worker 发布由 Cloudflare 平台接管，没有 Docker restart pending 状态；错误码必须和 update 拆开，前端才能区分动作。
 */
export async function systemRestart(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const locale = requestLocale(request);
  throw new HttpError(400, serverText(locale, "system.cloudflareRestartUnsupported"), "SYSTEM_RESTART_UNSUPPORTED");
}

function cloudflareBuildValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed;
}

function resolveCloudflareVersion(rawVersion: string | undefined): string {
  const version = cloudflareBuildValue(rawVersion, "");
  if (!version || version === DEV_VERSION || PLACEHOLDER_DEV_VERSION_PATTERN.test(version)) {
    // Deploy Button/Workers Builds 不一定注入 CI 元信息；缺省值代表官方稳定包版本，只有显式分支构建才允许展示 dev 后缀。
    return rootPackageJson.version;
  }
  if (STABLE_BUILD_VERSION_PATTERN.test(version) || BRANCH_BUILD_VERSION_PATTERN.test(version)) return version;
  return rootPackageJson.version;
}

async function checkLatestStableRelease(currentVersion: string, locale: ReturnType<typeof requestLocale>, env: Env) {
  try {
    const release = await fetchLatestStableRelease(env);
    if (!release) return releaseCheckDeferred(currentVersion, locale);
    const latest = parseStableVersion(release.tagName);
    const current = parseComparableVersion(currentVersion);
    if (!latest || !current) return releaseCheckDeferred(currentVersion, locale);
    const latestVersion = versionToString(latest);
    const hasUpdate = compareVersion(latest, current) > 0;
    const currentIsStableRelease = parseStableVersion(currentVersion) !== null;
    return {
      latestVersion,
      hasUpdate,
      checkSucceeded: true,
      releaseInfo: hasUpdate || currentIsStableRelease ? releaseInfoFromSource(release, latestVersion) : null,
      warning: undefined,
      errorDetails: undefined,
    };
  } catch (error) {
    return releaseCheckDeferred(currentVersion, locale, upstreamErrorDetailsFromError(error));
  }
}

function releaseCheckDeferred(currentVersion: string, locale: ReturnType<typeof requestLocale>, errorDetails?: ReturnType<typeof upstreamErrorDetailsFromError>) {
  return {
    latestVersion: currentVersion,
    hasUpdate: false,
    checkSucceeded: false,
    releaseInfo: null,
    warning: serverText(locale, "system.versionCheckUnavailableWarning"),
    errorDetails,
  };
}

async function fetchLatestStableRelease(env: Env): Promise<SystemReleaseEntry | null> {
  const headers: HeadersInit = {
    accept: "application/atom+xml",
    "user-agent": `Renewlet/${env.RENEWLET_VERSION?.trim() || rootPackageJson.version}`,
  };
  let response: Response;
  response = await sendUpstreamRequest(SYSTEM_RELEASE_FEED_URL, { headers }, {
    provider: "GitHub",
    timeoutMs: 15_000,
  });
  const body = await readUpstreamResponseBody(response, SYSTEM_RELEASE_FEED_LIMIT_BYTES);
  const providerResponse = upstreamProviderResponseFromBody(response, body.text, body.truncated);
  if (!response.ok) {
    const providerMessage = providerMessageFromResponse(providerResponse);
    throw createUpstreamHTTPError({
      provider: "GitHub",
      response,
      providerResponse,
      providerMessage,
    });
  }
  try {
    return parseLatestStableReleaseAtomFeed(body.text);
  } catch {
    throw new UpstreamOperationError("GitHub Release feed shape is invalid", createUpstreamErrorDetails({
      providerResponse,
    }));
  }
}

function releaseInfoFromSource(release: SystemReleaseEntry, version: string) {
  return {
    tagName: release.tagName,
    version,
    name: release.name,
    body: release.body,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl,
    assets: [],
  };
}

function parseLatestStableReleaseAtomFeed(text: string): SystemReleaseEntry | null {
  const parsed = releaseFeedParser.parse(text) as AtomFeedValue;
  for (const entry of toArray(parsed.feed?.entry)) {
    const release = releaseFromAtomEntry(entry);
    if (release && parseStableVersion(release.tagName)) return release;
  }
  return null;
}

function releaseFromAtomEntry(entry: AtomEntryValue): SystemReleaseEntry | null {
  const href = releaseLinkHref(entry);
  const rawTag = href.match(/\/releases\/tag\/([^/?#"]+)/i)?.[1] ?? "";
  const tagName = rawTag ? decodePathSegment(rawTag).trim() : atomText(entry.title);
  if (!parseComparableVersion(tagName)) return null;
  return {
    tagName,
    name: atomText(entry.title) || tagName,
    body: atomText(entry.content),
    publishedAt: atomText(entry.updated),
    htmlUrl: href || `https://github.com/zhiyingzzhou/renewlet/releases/tag/${encodeURIComponent(tagName)}`,
  };
}

function releaseLinkHref(entry: AtomEntryValue): string {
  for (const link of toArray(entry.link)) {
    const href = typeof link.href === "string" ? link.href.trim() : "";
    if (href.includes("/releases/tag/")) return href;
  }
  return "";
}

function atomText(value: AtomTextValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  const text = value?.["#text"];
  return typeof text === "string" ? text.trim() : "";
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseStableVersion(rawVersion: string): ParsedVersion | null {
  return parseVersion(rawVersion, STABLE_VERSION_PATTERN);
}

function parseComparableVersion(rawVersion: string): ParsedVersion | null {
  return parseVersion(rawVersion, COMPARABLE_VERSION_PATTERN);
}

function parseVersion(rawVersion: string, pattern: RegExp): ParsedVersion | null {
  const match = pattern.exec(rawVersion.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  return compareNumber(left.major, right.major) || compareNumber(left.minor, right.minor) || compareNumber(left.patch, right.patch);
}

function compareNumber(left: number, right: number): number {
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

function versionToString(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
