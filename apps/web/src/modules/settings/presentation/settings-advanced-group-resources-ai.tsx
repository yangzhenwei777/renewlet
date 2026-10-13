import { useLayoutEffect, useRef } from "react";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { useUploadedAssetsManager } from "../application/use-uploaded-assets-manager";
import { AIRecognitionSettingsSection } from "./ai-recognition-settings-section";
import { BuiltInIconSourcesSection } from "./built-in-icon-sources-section";
import { SETTINGS_SECTION_SCROLL_CLASS } from "./settings-layout";
import { UploadedIconsSection } from "./uploaded-icons-section";

export function SettingsAdvancedResourcesAiGroup({
  controller,
  onReady,
}: {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
}) {
  const { settings, secretStatus, clearSecret, updateSetting, builtInIconIndex, externalIntegrationsDisabled } = controller;
  const uploadedAssets = useUploadedAssetsManager();
  const readyRef = useRef(false);

  useLayoutEffect(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    onReady?.();
  }, [onReady]);

  return (
    <>
      <BuiltInIconSourcesSection
        id="settings-icon-sources"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        sources={settings.builtInIconSources}
        onChange={(sources) => updateSetting("builtInIconSources", sources)}
        onlineSources={settings.onlineIconSources}
        onOnlineChange={(sources) => updateSetting("onlineIconSources", sources)}
        iconIndex={builtInIconIndex}
      />
      <UploadedIconsSection id="settings-uploaded-icons" className={SETTINGS_SECTION_SCROLL_CLASS} controller={uploadedAssets} />
      <AIRecognitionSettingsSection
        id="settings-ai-recognition"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        settings={settings.aiRecognition}
        onChange={(aiRecognition) => updateSetting("aiRecognition", aiRecognition)}
        apiKeyConfigured={secretStatus["aiRecognition.apiKey"].configured}
        onClearApiKey={() => clearSecret("aiRecognition.apiKey")}
        disabled={externalIntegrationsDisabled}
      />
    </>
  );
}
