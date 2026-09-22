import { memo } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import {
  CustomConfigProvider,
  useCustomConfigActions,
  useCustomConfigState,
} from "./CustomConfigContext";

const contextMocks = vi.hoisted(() => ({
  controller: {
    config: null as CustomConfig | null,
    saveConfig: vi.fn(),
  },
}));

vi.mock("@/modules/custom-config/application/use-custom-config-state", () => ({
  useCustomConfigController: () => contextMocks.controller,
}));

describe("CustomConfigProvider", () => {
  beforeEach(() => {
    contextMocks.controller = {
      config: DEFAULT_CUSTOM_CONFIG,
      saveConfig: vi.fn(),
    };
  });

  it("publishes state and actions through independent update scopes", () => {
    const stateRender = vi.fn();
    const actionsRender = vi.fn();
    const StateConsumer = memo(function StateConsumer() {
      stateRender(useCustomConfigState().config);
      return null;
    });
    const ActionsConsumer = memo(function ActionsConsumer() {
      actionsRender(useCustomConfigActions().saveConfig);
      return null;
    });
    const view = () => (
      <CustomConfigProvider>
        <StateConsumer />
        <ActionsConsumer />
      </CustomConfigProvider>
    );
    const { rerender } = render(view());

    const nextSaveConfig = vi.fn();
    contextMocks.controller = {
      config: DEFAULT_CUSTOM_CONFIG,
      saveConfig: nextSaveConfig,
    };
    rerender(view());
    expect(stateRender).toHaveBeenCalledTimes(1);
    expect(actionsRender).toHaveBeenCalledTimes(2);

    contextMocks.controller = {
      config: { ...DEFAULT_CUSTOM_CONFIG, categories: [...DEFAULT_CUSTOM_CONFIG.categories] },
      saveConfig: nextSaveConfig,
    };
    rerender(view());
    expect(stateRender).toHaveBeenCalledTimes(2);
    expect(actionsRender).toHaveBeenCalledTimes(2);
  });
});
