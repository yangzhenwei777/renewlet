import type { MessageKey } from "@/i18n/messages";
import type { AiRecognitionSettings } from "@/lib/api/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";

// 入口就绪态只检查当前 provider endpoint 的必填项，真实凭证可用性仍由后端代理请求第三方验证。
export function getAIRecognitionSettingsBlocker(settings: AiRecognitionSettings, apiKeyConfigured = false): MessageKey | null {
  if (!settings.model.trim()) return "aiRecognition.modelRequired";
  const endpoint = resolveAIProviderEndpoint(settings);
  if (endpoint.baseUrlRequired && !settings.baseUrl.trim()) {
    return "aiRecognition.baseUrlRequired";
  }
  if (endpoint.apiKeyRequired && !settings.apiKey.trim() && !apiKeyConfigured) {
    return "aiRecognition.apiKeyRequired";
  }
  return null;
}
