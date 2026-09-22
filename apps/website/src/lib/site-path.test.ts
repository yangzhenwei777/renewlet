import { afterEach, describe, expect, it, vi } from 'vitest'

import { websitePath } from './site-path'

describe('websitePath', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps the root base URL unchanged', () => {
    expect(websitePath('', '/')).toBe('/')
  })

  it('keeps the GitHub Pages repository base URL unchanged', () => {
    // 默认项目页部署依赖 /renewlet/ 子路径，不能被路径拼接逻辑吃掉尾随斜杠。
    expect(websitePath('', '/renewlet/')).toBe('/renewlet/')
  })

  it('joins nested website paths under the configured base URL', () => {
    expect(websitePath('en/', '/renewlet/')).toBe('/renewlet/en/')
  })

  it('normalizes a base URL without a trailing slash', () => {
    expect(websitePath('', '/renewlet')).toBe('/renewlet/')
  })

  it('uses the current Vite base URL by default', () => {
    vi.stubEnv('BASE_URL', '/renewlet/')

    expect(websitePath()).toBe('/renewlet/')
  })
})
