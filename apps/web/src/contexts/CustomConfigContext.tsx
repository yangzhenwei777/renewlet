import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useCustomConfigController } from "@/modules/custom-config/application/use-custom-config-state";
import type { CustomConfig } from "@/types/config";

interface CustomConfigStateValue {
  config: CustomConfig;
}

interface CustomConfigActionsValue {
  saveConfig: (config: CustomConfig) => Promise<CustomConfig>;
}

const CustomConfigStateContext = createContext<CustomConfigStateValue | null>(null);
const CustomConfigActionsContext = createContext<CustomConfigActionsValue | null>(null);

/** 配置数据与写动作分开发布，保存状态变化不会让所有只读卡片重新渲染。 */
export function CustomConfigProvider({ children }: { children: ReactNode }) {
  const { config, saveConfig } = useCustomConfigController();
  const stateValue = useMemo(() => ({ config }), [config]);
  const actionsValue = useMemo(() => ({ saveConfig }), [saveConfig]);

  return (
    <CustomConfigActionsContext.Provider value={actionsValue}>
      <CustomConfigStateContext.Provider value={stateValue}>
        {children}
      </CustomConfigStateContext.Provider>
    </CustomConfigActionsContext.Provider>
  );
}

export function useCustomConfigState(): CustomConfigStateValue {
  const context = useContext(CustomConfigStateContext);
  if (!context) {
    throw new Error("useCustomConfigState must be used within a CustomConfigProvider");
  }
  return context;
}

export function useCustomConfigActions(): CustomConfigActionsValue {
  const context = useContext(CustomConfigActionsContext);
  if (!context) {
    throw new Error("useCustomConfigActions must be used within a CustomConfigProvider");
  }
  return context;
}
