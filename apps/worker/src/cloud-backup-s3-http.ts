import { HttpRequest, buildQueryString } from "@smithy/core/protocols";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { CronBudget } from "./cron-budget";
import { UPSTREAM_MAX_REDIRECTS, UPSTREAM_REDIRECT_STATUSES, upstreamRedirect } from "./upstream-redirect";

type HandlerOptions = NonNullable<Parameters<FetchHttpHandler["handle"]>[1]>;

export class CronS3HttpHandler extends FetchHttpHandler {
  constructor(private readonly budget: CronBudget, private readonly timeoutMs: number) {
    super({ cache: "no-store", requestInit: () => ({ redirect: "manual" }) });
  }

  override async handle(request: HttpRequest, options: HandlerOptions = {}) {
    const startedAt = Date.now();
    const timeout = options.requestTimeout ?? this.timeoutMs;
    let current = request;
    for (let redirects = 0; ; redirects++) {
      const remaining = timeout - (Date.now() - startedAt);
      if (timeout > 0 && remaining <= 0) throw Object.assign(new Error("S3 request timed out"), { name: "TimeoutError" });
      if (options.abortSignal?.aborted) throw Object.assign(new Error("S3 request aborted"), { name: "AbortError" });
      this.budget.consumeExternalRequest();
      // 每跳继续使用SDK官方的Request/Response转换及no-store；超时覆盖整条链，不在重定向后重置。
      const result = await super.handle(current, { ...options, requestTimeout: timeout > 0 ? remaining : 0 });
      const { statusCode, headers } = result.response;
      const location = headers["location"];
      if (!UPSTREAM_REDIRECT_STATUSES.has(statusCode) || location === undefined) return result;
      const body: unknown = result.response.body;
      if (body instanceof ReadableStream) await body.cancel();
      if (redirects === UPSTREAM_MAX_REDIRECTS) throw new TypeError("Too many S3 redirects");
      const query = buildQueryString(current.query ?? {});
      const url = new URL(`${current.protocol}//${current.hostname}${current.port ? `:${current.port}` : ""}${current.path}${query ? `?${query}` : ""}`);
      const redirect = upstreamRedirect(url, location, statusCode, current.method, current.body instanceof ReadableStream);
      const next = redirect.url;
      current = HttpRequest.clone(current);
      // 当前部署的workerd在跨源重定向时剥离Authorization；不能因手动逐跳计数扩大凭据转发范围。
      if (next.origin !== url.origin) {
        for (const name of Object.keys(current.headers)) if (name.toLowerCase() === "authorization") delete current.headers[name];
      }
      current.protocol = next.protocol;
      current.hostname = next.hostname;
      if (next.port) current.port = Number(next.port);
      else delete current.port;
      // 已由URL解析的Location保持原始query编码，不把签名URL再拆解/排序。
      current.path = next.pathname + next.search;
      current.query = {};
      current.fragment = next.hash.slice(1);
      current.method = redirect.method;
      if (redirect.dropBody) current.body = undefined;
      // workerd切为GET时保留Content-*；正文长度由fetch按实际body处理。
    }
  }
}
