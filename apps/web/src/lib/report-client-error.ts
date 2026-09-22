// 仅保留浏览器本地控制台诊断；这里不能接入远端上报，避免误收集用户的订阅名称或上游响应内容。
export function reportClientError(error: unknown, context: Record<string, unknown> = {}) {
  console.error("client error", { error, ...context });
}
