import { describe, expect, it } from 'vitest'

import { responsiveScreenshotAsset, screenshotName } from './renewlet-image-assets'

describe('renewlet image assets', () => {
  it('uses mobile responsive candidates for h5 screenshots', () => {
    // H5 截图必须走手机宽度候选，避免移动官网首屏下载桌面 1400w 资源。
    for (const key of ['notifications-h5', 'subscriptions-h5'] as const) {
      const asset = responsiveScreenshotAsset(screenshotName(key, 'zh'), 'featurePhone')

      expect(asset.avif).toContain(`${key}-zh-430.avif 430w`)
      expect(asset.avif).toContain(`${key}-zh-860.avif 860w`)
      expect(asset.webp).toContain(`${key}-zh-430.webp 430w`)
      expect(asset.webp).toContain(`${key}-zh-860.webp 860w`)
      expect(asset.avif).not.toContain(`${key}-zh-1400`)
      expect(asset.webp).not.toContain(`${key}-zh-1400`)
      expect(asset.width).toBe(430)
      expect(asset.height).toBe(932)
    }
  })
})
