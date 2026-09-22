import type { ReactNode } from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

interface RechartsFrameProps {
  /** Recharts 图表节点；外层只负责尺寸和首帧容器稳定性。 */
  children: ReactNode;
  /** 固定图表高度，避免 ResponsiveContainer 首帧从 0 高度开始测量。 */
  height: number;
  className?: string;
  testId?: string;
}

/**
 * Recharts 容器适配层。
 *
 * 这里把尺寸约束集中到一个组件，避免统计页每个图表都各自处理 Recharts 3 的首帧测量 warning。
 */
export function RechartsFrame({ children, height, className, testId }: RechartsFrameProps) {
  return (
    <div className={cn("recharts-frame min-w-0", className)} style={{ height }} data-testid={testId}>
      <ResponsiveContainer
        width="100%"
        height={height}
        minWidth={0}
        // Recharts 3 首轮默认尺寸是 -1/-1；正数初始尺寸能避免访问统计页时先打印尺寸 warning。
        initialDimension={{ width: height, height }}
        debounce={50}
      >
        {children}
      </ResponsiveContainer>
    </div>
  );
}
