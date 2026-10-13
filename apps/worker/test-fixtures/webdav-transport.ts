import { WorkerWebDAVClient } from "../src/cloud-backup-webdav";
import { CronBudget } from "../src/cron-budget";

// 隔离入口只接受回环服务器和虚构凭据；生产WebDAV配置的HTTPS约束不在这里放宽。
const worker = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = new URL(url.searchParams.get("endpoint") ?? "http://127.0.0.1");
    if (endpoint.hostname !== "127.0.0.1") throw new Error("Loopback fixture only");
    if (url.pathname === "/parallel") {
      return Response.json(await Promise.all(["limited", "counted", "manual"].map(async (name) => {
        const next = new URL(url); next.pathname = "/";
        next.searchParams.set("endpoint", endpoint.href + "/" + name);
        next.searchParams.set("reserved", name === "limited" ? "49" : "0");
        next.searchParams.set("handler", name === "manual" ? "native" : "counted");
        return (await worker.fetch(new Request(next))).json();
      })));
    }
    const budget = new CronBudget();
    budget.consumeExternal(Number(url.searchParams.get("reserved") ?? 0));
    const credentials = url.searchParams.get("auth") !== "none";
    const client = new WorkerWebDAVClient({ baseURL: endpoint.href,
      username: credentials ? "fixture-user" : "", password: credentials ? "fixture-password" : "",
      budget: url.searchParams.get("handler") === "native" ? undefined : budget });
    try {
      let value: unknown;
      switch (url.searchParams.get("operation")) {
        case "put": await client.put("file", new TextEncoder().encode("fixture-bytes"), "application/zip"); break;
        case "stat": value = await client.stat("file"); break;
        case "list": value = await client.list(""); break;
        case "delete": await client.delete("file"); break;
        case "directory": await client.ensureDirectory("folder", false); break;
        default: value = new TextDecoder().decode(await client.get("file"));
      }
      return Response.json({ value: value ?? null, resources: budget.used });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.name : "unknown", resources: budget.used });
    }
  },
};

export default worker;
