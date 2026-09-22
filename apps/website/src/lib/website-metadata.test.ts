import { describe, expect, it } from 'vitest'

import { latestStableReleaseVersionFromFileNames } from './release-version'
import {
  renderRobotsTxt,
  renderSitemapXml,
  replaceWebsiteMetadataPlaceholders,
  resolveWebsiteAnalyticsScript,
  resolveWebsiteDeployment,
  websiteUrl,
} from './website-metadata'

const UMAMI_ANALYTICS_SCRIPT =
  '<script defer src="https://umami.olyq.org/script.js" ' +
  'data-website-id="0da844f3-a2aa-419d-934a-dce961733c41"></script>'

describe('resolveWebsiteDeployment', () => {
  it('uses root asset paths for a GitHub Pages custom domain', () => {
    // 自定义域部署时资产从根路径读取，不能继续带 GitHub Pages 仓库名前缀。
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_BASE_URL: 'https://renewlet.cc',
      RENEWLET_WEBSITE_BASE_PATH: '',
    })

    expect(deployment).toMatchObject({
      basePath: '',
      baseUrl: 'https://renewlet.cc',
      viteBase: '/',
    })
  })

  it('uses repository asset paths for the default GitHub Pages project URL', () => {
    // 默认 project page 仍需要 /renewlet/ 作为 Vite base，否则刷新和截图资源会 404。
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_BASE_URL: 'https://zhiyingzzhou.github.io/renewlet',
      RENEWLET_WEBSITE_BASE_PATH: '/renewlet',
    })

    expect(deployment).toMatchObject({
      basePath: '/renewlet',
      baseUrl: 'https://zhiyingzzhou.github.io/renewlet',
      viteBase: '/renewlet/',
    })
  })

  it('normalizes trailing slashes from GitHub Pages metadata', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_BASE_URL: 'https://zhiyingzzhou.github.io/renewlet/',
      RENEWLET_WEBSITE_BASE_PATH: 'renewlet/',
    })

    expect(deployment.baseUrl).toBe('https://zhiyingzzhou.github.io/renewlet')
    expect(deployment.basePath).toBe('/renewlet')
    expect(deployment.viteBase).toBe('/renewlet/')
  })

  it('upgrades public GitHub Pages HTTP metadata to HTTPS', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_BASE_URL: 'http://renewlet.cc',
      RENEWLET_WEBSITE_BASE_PATH: '',
    })

    expect(deployment.baseUrl).toBe('https://renewlet.cc')
  })

  it('keeps local preview metadata on HTTP', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_BASE_URL: 'http://localhost:4173',
      RENEWLET_WEBSITE_BASE_PATH: '',
    })

    expect(deployment.baseUrl).toBe('http://localhost:4173')
  })

  it('uses the default public repository URL for local builds', () => {
    const deployment = resolveWebsiteDeployment()

    expect(deployment.repositoryUrl).toBe('https://github.com/zhiyingzzhou/renewlet')
    expect(deployment.repositoryLinks.license).toBe('https://github.com/zhiyingzzhou/renewlet/blob/main/LICENSE')
  })

  it('normalizes the configured repository URL and derives repository links from it', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_REPOSITORY_URL: 'https://github.example.com/acme/renewlet/',
    })

    expect(deployment.repositoryUrl).toBe('https://github.example.com/acme/renewlet')
    expect(deployment.repositoryLinks).toEqual({
      github: 'https://github.example.com/acme/renewlet',
      docs: 'https://github.example.com/acme/renewlet#readme',
      docsZh: 'https://github.example.com/acme/renewlet/blob/main/README.zh-CN.md',
      cloudflare: {
        zh: 'https://github.example.com/acme/renewlet/blob/main/docs/cloudflare-workers-deploy.zh-CN.md',
        en: 'https://github.example.com/acme/renewlet/blob/main/docs/cloudflare-workers-deploy.md',
      },
      docker: 'https://github.example.com/acme/renewlet/blob/main/README.zh-CN.md#快速部署',
      license: 'https://github.example.com/acme/renewlet/blob/main/LICENSE',
    })
  })

  it('upgrades public repository HTTP URLs to HTTPS', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_REPOSITORY_URL: 'http://github.example.com/acme/renewlet',
    })

    expect(deployment.repositoryUrl).toBe('https://github.example.com/acme/renewlet')
  })

  it('keeps analytics disabled when the script is missing', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_ANALYTICS_SCRIPT: '',
    })

    expect(deployment.analyticsScript).toBe('')
  })

  it('normalizes analytics script HTML when it is configured', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_ANALYTICS_SCRIPT:
        '<script data-website-id="site-123" ' +
        'src="http://analytics.example.com/script.js?tracker=renewlet#frag" defer></script>',
    })

    expect(deployment.analyticsScript).toBe(
      '<script defer src="https://analytics.example.com/script.js?tracker=renewlet" ' +
        'data-website-id="site-123"></script>',
    )
  })
})

describe('website metadata rendering', () => {
  const customDomainDeployment = resolveWebsiteDeployment({
    RENEWLET_WEBSITE_BASE_URL: 'https://renewlet.cc',
    RENEWLET_WEBSITE_BASE_PATH: '',
  })

  it('joins absolute website URLs under the configured Pages URL', () => {
    expect(websiteUrl(customDomainDeployment)).toBe('https://renewlet.cc/')
    expect(websiteUrl(customDomainDeployment, 'en/')).toBe('https://renewlet.cc/en/')
  })

  it('renders robots.txt from the configured Pages URL', () => {
    expect(renderRobotsTxt(customDomainDeployment)).toContain('Sitemap: https://renewlet.cc/sitemap.xml')
  })

  it('renders sitemap URLs from the configured Pages URL', () => {
    const sitemap = renderSitemapXml(customDomainDeployment)

    expect(sitemap).toContain('<loc>https://renewlet.cc/</loc>')
    expect(sitemap).toContain('<loc>https://renewlet.cc/en/</loc>')
    expect(sitemap).toContain('<lastmod>2026-06-19</lastmod>')
    expect(sitemap).not.toContain('zhiyingzzhou.github.io/renewlet')
  })

  it('replaces HTML placeholders with configured absolute URLs', () => {
    // SEO/OG 占位符在 build 阶段替换为绝对 URL，避免社交抓取器依赖客户端 JS。
    const html = [
      '%RENEWLET_WEBSITE_URL%',
      '%RENEWLET_WEBSITE_EN_URL%',
      '%RENEWLET_WEBSITE_LOGO_URL%',
      '%RENEWLET_WEBSITE_DASHBOARD_ZH_URL%',
      '%RENEWLET_WEBSITE_DASHBOARD_EN_URL%',
      '%RENEWLET_WEBSITE_SOFTWARE_VERSION%',
      '%RENEWLET_WEBSITE_REPOSITORY_URL%',
      '%RENEWLET_WEBSITE_LICENSE_URL%',
    ].join('\n')

    expect(replaceWebsiteMetadataPlaceholders(html, customDomainDeployment, { softwareVersion: '0.1.9' })).toBe(
      [
        'https://renewlet.cc/',
        'https://renewlet.cc/en/',
        'https://renewlet.cc/assets/renewlet/logo.svg',
        'https://renewlet.cc/assets/renewlet/images/dashboard-zh.png',
        'https://renewlet.cc/assets/renewlet/images/dashboard-en.png',
        '0.1.9',
        'https://github.com/zhiyingzzhou/renewlet',
        'https://github.com/zhiyingzzhou/renewlet/blob/main/LICENSE',
      ].join('\n'),
    )
  })

  it('injects the configured repository URL into JSON-LD placeholders', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_REPOSITORY_URL: 'https://github.example.com/acme/renewlet/',
    })
    const html = [
      '"sameAs": ["%RENEWLET_WEBSITE_REPOSITORY_URL%"]',
      '"codeRepository": "%RENEWLET_WEBSITE_REPOSITORY_URL%"',
      '"license": "%RENEWLET_WEBSITE_LICENSE_URL%"',
    ].join('\n')

    expect(replaceWebsiteMetadataPlaceholders(html, deployment, { softwareVersion: '0.1.9' })).toBe(
      [
        '"sameAs": ["https://github.example.com/acme/renewlet"]',
        '"codeRepository": "https://github.example.com/acme/renewlet"',
        '"license": "https://github.example.com/acme/renewlet/blob/main/LICENSE"',
      ].join('\n'),
    )
  })

  it('removes the analytics placeholder when the script is not configured', () => {
    const html = '<body>%RENEWLET_WEBSITE_ANALYTICS_SCRIPT%</body>'

    const rendered = replaceWebsiteMetadataPlaceholders(html, customDomainDeployment, { softwareVersion: '0.1.9' })

    expect(rendered).toBe('<body></body>')
    expect(rendered).not.toContain('%RENEWLET_WEBSITE_ANALYTICS_SCRIPT%')
    expect(rendered).not.toContain('umami')
    expect(rendered).not.toContain('script src')
  })

  it('injects analytics when the script is configured', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_ANALYTICS_SCRIPT: UMAMI_ANALYTICS_SCRIPT,
    })

    expect(
      replaceWebsiteMetadataPlaceholders('%RENEWLET_WEBSITE_ANALYTICS_SCRIPT%', deployment, {
        softwareVersion: '0.1.9',
      }),
    ).toBe(UMAMI_ANALYTICS_SCRIPT)
  })

  it('normalizes whitespace and attribute order for configured analytics script HTML', () => {
    expect(
      resolveWebsiteAnalyticsScript(`
        <script
          data-website-id="0da844f3-a2aa-419d-934a-dce961733c41"
          src="https://umami.olyq.org/script.js"
          defer
        ></script>
      `),
    ).toBe(UMAMI_ANALYTICS_SCRIPT)
  })

  it('rejects invalid analytics script HTML', () => {
    for (const invalidScript of [
      '<div></div>',
      '<script src="https://umami.olyq.org/script.js"></script>' +
        '<script src="https://example.com/other.js"></script>',
      '<script src="https://umami.olyq.org/script.js">alert(1)</script>',
      '<script src="https://umami.olyq.org/script.js" onload="alert(1)"></script>',
      '<script defer></script>',
      '<script src="javascript:alert(1)"></script>',
    ]) {
      expect(() => resolveWebsiteAnalyticsScript(invalidScript)).toThrow()
    }
  })
})

describe('release note version selection', () => {
  it('uses the highest stable release note version and ignores RC files', () => {
    expect(
      latestStableReleaseVersionFromFileNames([
        'v0.1.8-zh.md',
        'v0.1.9-en.md',
        'v0.1.9-zh.md',
        'v0.2.0-rc.1-zh.md',
      ]),
    ).toBe('0.1.9')
  })
})
