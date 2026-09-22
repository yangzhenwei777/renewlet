import { describe, expect, it } from 'vitest'

import { resolveWebsiteDeployment } from '../lib/website-metadata'
import { createDeployOptions, createSiteLinks, localizedUrl } from './site'

describe('website content links', () => {
  it('derives user-facing repository links from the configured repository URL', () => {
    const deployment = resolveWebsiteDeployment({
      RENEWLET_WEBSITE_REPOSITORY_URL: 'https://github.example.com/acme/renewlet/',
    })
    const siteLinks = createSiteLinks(deployment.repositoryLinks)

    expect(siteLinks.github).toBe('https://github.example.com/acme/renewlet')
    expect(siteLinks.docs).toBe('https://github.example.com/acme/renewlet#readme')
    expect(siteLinks.docsZh).toBe('https://github.example.com/acme/renewlet/blob/main/README.zh-CN.md')
    expect(siteLinks.cloudflare.zh).toBe(
      'https://github.example.com/acme/renewlet/blob/main/docs/cloudflare-workers-deploy.zh-CN.md',
    )
    expect(siteLinks.cloudflare.en).toBe(
      'https://github.example.com/acme/renewlet/blob/main/docs/cloudflare-workers-deploy.md',
    )
    expect(siteLinks.docker).toBe('https://github.example.com/acme/renewlet/blob/main/README.zh-CN.md#快速部署')
    expect(siteLinks.license).toBe('https://github.example.com/acme/renewlet/blob/main/LICENSE')
  })

  it('feeds deployment options from the same repository links', () => {
    const siteLinks = createSiteLinks(
      resolveWebsiteDeployment({
        RENEWLET_WEBSITE_REPOSITORY_URL: 'https://github.example.com/acme/renewlet/',
      }).repositoryLinks,
    )
    const options = createDeployOptions(siteLinks)

    expect(options.find((option) => option.key === 'docker')?.href).toBe(
      'https://github.example.com/acme/renewlet/blob/main/README.zh-CN.md#快速部署',
    )
    expect(localizedUrl(options.find((option) => option.key === 'cloudflare')?.href ?? '', 'zh')).toBe(
      'https://github.example.com/acme/renewlet/blob/main/docs/cloudflare-workers-deploy.zh-CN.md',
    )
    expect(localizedUrl(options.find((option) => option.key === 'cloudflare')?.href ?? '', 'en')).toBe(
      'https://github.example.com/acme/renewlet/blob/main/docs/cloudflare-workers-deploy.md',
    )
  })
})
