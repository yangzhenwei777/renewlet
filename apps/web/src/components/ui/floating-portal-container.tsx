import * as React from "react";

export type FloatingPortalContainer = HTMLElement | null | undefined;

// undefined 表示没有父浮层容器，null 表示父浮层容器首帧 ref 未就绪；子浮层必须等待 null 变成 HTMLElement。
const FloatingPortalContainerContext = React.createContext<FloatingPortalContainer>(undefined);

export function FloatingPortalContainerProvider({
  children,
  container,
}: {
  children: React.ReactNode;
  container: FloatingPortalContainer;
}) {
  return (
    <FloatingPortalContainerContext.Provider value={container}>
      {children}
    </FloatingPortalContainerContext.Provider>
  );
}

export function useFloatingPortalContainer() {
  return React.useContext(FloatingPortalContainerContext);
}
