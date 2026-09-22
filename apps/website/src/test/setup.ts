import '@testing-library/jest-dom/vitest'
import { beforeEach, vi } from 'vitest'

function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function rejectUnexpectedConsoleCall(level: 'warn' | 'error') {
  return (...values: unknown[]): never => {
    throw new Error(`Unexpected console.${level}: ${values.map(formatConsoleValue).join(' ')}`)
  }
}

// Radix/Vaul 在 jsdom 下会探测 pointer capture；测试环境补空实现，避免布局用例被浏览器 API 缺失卡住。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
}

if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}

if (!Element.prototype.scrollIntoView) {
  // 官网组件只关心目标元素存在，jsdom 不做真实滚动，空实现能让焦点/弹层测试稳定。
  Element.prototype.scrollIntoView = () => {}
}

beforeEach(() => {
  // 官网测试只允许用例显式接管的预期故障日志，避免 React 或依赖告警随成功结果一起被忽略。
  vi.spyOn(console, 'warn').mockImplementation(rejectUnexpectedConsoleCall('warn'))
  vi.spyOn(console, 'error').mockImplementation(rejectUnexpectedConsoleCall('error'))
})
