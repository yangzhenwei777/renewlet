/**
 * 产品认证适配层。
 *
 * Docker 与 Cloudflare 都只消费 Renewlet `/api/app/auth/*`；PocketBase SDK 不再参与登录态恢复，
 * 避免启用 MFA 后原生 `authWithPassword/authRefresh` 成为绕过口。
 */
import {
  QueryObserver,
  queryOptions,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { pb } from "@/lib/pocketbase";
import { ApiError } from "@/lib/api-client";
import { getLocaleHeaders } from "@/i18n/api-locale";
import {
  getProductCsrfHeader,
  isProductSessionFresh,
  readProductSessionRecord,
  subscribeProductSession,
  writeProductSession,
  type ProductSessionRecord,
} from "@/services/product-session";
import { passkeyService } from "@/services/passkey-service";
import { isCloudflareRuntime } from "@/services/runtime";
import {
  loginResponseSchema,
  mfaVerifyBodySchema,
  sessionResponseSchema,
  type LoginResponse,
  type MfaVerifyBody,
  type SessionResponse,
} from "@renewlet/shared/schemas/auth";

export type SessionData = SessionResponse;

export interface UseSessionResult {
  data: SessionData | null;
  isPending: boolean;
}

interface PasskeySignInOptions {
  useBrowserAutofill?: boolean;
  shouldPersistSession?: (session: SessionData) => boolean;
}

interface VerifyMfaOptions {
  shouldPersistSession?: (session: SessionData) => boolean;
}

const SESSION_QUERY_KEY = ["auth-session"] as const;
const SESSION_STALE_TIME_MS = 60_000;
const CLOUDFLARE_PASSWORD_RESET_DISABLED = "Email password reset is not enabled for this deployment.";

async function fetchAuthJson(input: RequestInfo, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type") && init?.body) headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(getLocaleHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }
  if (init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    for (const [key, value] of Object.entries(getProductCsrfHeader())) {
      if (!headers.has(key)) headers.set(key, value);
    }
  }
  const response = await fetch(input, { ...init, headers, credentials: "include" });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const payloadRecord = recordFromUnknown(payload);
    const errorBody = recordFromUnknown(payloadRecord?.["error"]);
    const message = typeof errorBody?.["message"] === "string"
      ? errorBody["message"]
      : typeof payloadRecord?.["message"] === "string"
        ? payloadRecord["message"]
        : response.statusText;
    const code = typeof errorBody?.["code"] === "string" ? errorBody["code"] : undefined;
    throw new ApiError(message || "Request failed", response.status, errorBody?.["details"], code);
  }
  return payload;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function fetchSession(input: RequestInfo, init?: RequestInit): Promise<SessionData> {
  const payload = await fetchAuthJson(input, init);
  const parsed = sessionResponseSchema.safeParse(payload);
  // session 响应决定私有路由是否放行；未知 JSON 必须中断，不能降级成“已登录”。
  if (!parsed.success) throw new Error("Invalid session response");
  return parsed.data.data;
}

async function fetchLogin(input: RequestInfo, init?: RequestInit): Promise<LoginResponse> {
  const payload = await fetchAuthJson(input, init);
  const parsed = loginResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid login response");
  return parsed.data.data;
}

async function requestFreshSession(key: string, signal: AbortSignal): Promise<SessionData | null> {
  try {
    const session = await fetchSession("/api/app/auth/session", { signal });
    const currentRecord = readProductSessionRecord();
    if (sessionRecordKey(currentRecord) === key) {
      writeProductSession(session);
      return session;
    }
    return currentRecord?.value ?? null;
  } catch (error) {
    if (signal.aborted) throw error;
    const currentRecord = readProductSessionRecord();
    if (sessionRecordKey(currentRecord) === key) {
      writeProductSession(null);
      return null;
    }
    return currentRecord?.value ?? null;
  }
}

function refreshSession(signal: AbortSignal): Promise<SessionData | null> {
  const record = readProductSessionRecord();
  if (!record) return Promise.resolve(null);
  return requestFreshSession(sessionRecordKey(record), signal);
}

function sessionRecordKey(record: ProductSessionRecord | null): string {
  if (!record) return "";
  return `${record.value.user.id}:${record.value.session.expiresAt}:${record.verifiedAt}`;
}

function sessionQueryOptions(sessionRecord: ProductSessionRecord | null) {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => refreshSession(signal),
    initialData: () => sessionRecord?.value ?? null,
    initialDataUpdatedAt: () => sessionRecord?.verifiedAt ?? 0,
    enabled: Boolean(sessionRecord),
    retry: false,
    staleTime: SESSION_STALE_TIME_MS,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}

function useProductSession(): UseSessionResult {
  const sessionRecord = readProductSessionRecord();
  const sessionQuery = useQuery(sessionQueryOptions(sessionRecord));

  const isInitialValidation =
    sessionQuery.fetchStatus === "fetching" &&
    !isProductSessionFresh(sessionRecord, SESSION_STALE_TIME_MS);

  return {
    data: sessionQuery.data ?? null,
    isPending: isInitialValidation,
  };
}

export function initializeProductSessionQuery(queryClient: QueryClient): () => void {
  const observer = new QueryObserver(queryClient, sessionQueryOptions(readProductSessionRecord()));
  const sync = () => {
    const record = readProductSessionRecord();
    queryClient.setQueryData(
      SESSION_QUERY_KEY,
      record?.value ?? null,
      record ? { updatedAt: record.verifiedAt } : undefined,
    );
    observer.setOptions(sessionQueryOptions(record));
  };
  const unsubscribeSession = subscribeProductSession(sync);
  sync();
  const unsubscribeObserver = observer.subscribe(() => undefined);

  // 应用级 observer 跨越 StrictMode 的探测性卸载；TanStack Query 因而独占请求去重、取消和缓存所有权。
  return () => {
    unsubscribeObserver();
    unsubscribeSession();
  };
}

export const authClient = {
  cancelPasskeyCeremony(): void {
    passkeyService.cancelActiveCeremony();
  },

  useSession: useProductSession,

  signIn: {
    async email({ email, password, turnstileToken }: { email: string; password: string; turnstileToken?: string }) {
      try {
        const data = await fetchLogin("/api/app/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            ...(turnstileToken ? { turnstileToken } : {}),
          }),
        });
        if (data.type === "mfa_required") {
          // mfa_required 只返回给登录页状态机；认证适配层不能把 ticket 写成 session 或持久化。
          return { data, error: null };
        }
        writeProductSession(data);
        return { data, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },

    async passkey(options: PasskeySignInOptions = {}) {
      try {
        const { shouldPersistSession, ...passkeyOptions } = options;
        const result = await passkeyService.authenticate(passkeyOptions);
        if (result.status === "cancelled") {
          // authClient 是产品 session 写入边界；取消必须交还 UI 状态机，不能落入通用登录失败路径。
          return { data: null, error: null, cancelled: true };
        }
        if (shouldPersistSession?.(result.session) ?? true) {
          writeProductSession(result.session);
        }
        return { data: result.session, error: null, cancelled: false };
      } catch (error) {
        return { data: null, error, cancelled: false };
      }
    },
  },

  async verifyMfa(body: MfaVerifyBody, options: VerifyMfaOptions = {}) {
    try {
      const payload = mfaVerifyBodySchema.parse(body);
      const session = await fetchSession("/api/app/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (options.shouldPersistSession?.(session) ?? true) {
        writeProductSession(session);
      }
      return { data: session, error: null };
    } catch (error) {
      return { data: null, error };
    }
  },

  async signOut() {
    try {
      await fetch("/api/app/auth/logout", { method: "POST", headers: getProductCsrfHeader(), credentials: "include" });
    } finally {
      writeProductSession(null);
    }
  },

  async requestPasswordReset(email: string) {
    if (isCloudflareRuntime) {
      void email;
      throw new Error(CLOUDFLARE_PASSWORD_RESET_DISABLED);
    }
    await pb.collection("users").requestPasswordReset(email);
  },

  async confirmPasswordReset(token: string, password: string) {
    if (isCloudflareRuntime) {
      void token;
      void password;
      throw new Error(CLOUDFLARE_PASSWORD_RESET_DISABLED);
    }
    await pb.collection("users").confirmPasswordReset(token, password, password);
  },
};
