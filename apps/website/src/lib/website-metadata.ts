const LOCAL_PREVIEW_BASE_URL = 'http://localhost:4173'
const DEFAULT_REPOSITORY_URL = 'https://github.com/zhiyingzzhou/renewlet'
const REPOSITORY_DOCS_BRANCH = 'main'
const SITEMAP_LASTMOD = '2026-06-19'
const BOOLEAN_ANALYTICS_SCRIPT_ATTRIBUTES = new Set(['defer', 'async'])
const VALUED_ANALYTICS_SCRIPT_ATTRIBUTES = new Set([
  'integrity',
  'crossorigin',
  'referrerpolicy',
  'fetchpriority',
  'nonce',
])
const ANALYTICS_SCRIPT_ATTRIBUTE_ORDER = ['defer', 'async', 'src']

export type WebsiteEnv = Record<string, string | undefined>

export type WebsiteRepositoryLinks = {
  github: string
  docs: string
  docsZh: string
  cloudflare: {
    zh: string
    en: string
  }
  docker: string
  license: string
}

export type WebsiteDeployment = {
  basePath: string
  baseUrl: string
  repositoryLinks: WebsiteRepositoryLinks
  repositoryUrl: string
  analyticsScript: string
  viteBase: string
}

export type WebsiteMetadata = {
  softwareVersion: string
}

function normalizeBasePath(rawBasePath: string | undefined) {
  const trimmed = rawBasePath?.trim() ?? ''
  if (!trimmed || trimmed === '/') return ''

  // basePath 用于 Vite asset 前缀，只保留 path 段，避免环境变量里多余斜杠影响静态资源 URL。
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash.replace(/\/+$/, '')
}

function normalizeBaseUrl(rawBaseUrl: string | undefined) {
  const candidate = rawBaseUrl?.trim() || LOCAL_PREVIEW_BASE_URL
  const url = parseHttpUrl(candidate, 'website base URL')

  // sitemap/OG URL 必须是稳定 origin + path，不继承预览链接里的 query/hash。
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

function isLocalHostname(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
}

function parseHttpUrl(candidate: string, description: string) {
  const url = new URL(candidate)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Expected an HTTP(S) ${description}, received ${candidate}`)
  }
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname)) {
    url.protocol = 'https:'
  }
  return url
}

function normalizePublicHttpUrl(rawUrl: string | undefined, fallbackUrl: string) {
  const candidate = rawUrl?.trim() || fallbackUrl
  const url = parseHttpUrl(candidate, 'public URL')

  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

type ScriptAttribute = {
  name: string
  value: string | null
}

function parseScriptAttributes(source: string) {
  const attributes: ScriptAttribute[] = []
  let index = 0

  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1
    if (index >= source.length) break

    const nameStart = index
    while (index < source.length && !/[\s=]/.test(source[index])) index += 1
    const rawName = source.slice(nameStart, index)
    if (!rawName || !/^[a-zA-Z][a-zA-Z0-9:._-]*$/.test(rawName)) {
      throw new Error('Invalid analytics script attribute name')
    }

    while (/\s/.test(source[index] ?? '')) index += 1

    let value: string | null = null
    if (source[index] === '=') {
      index += 1
      while (/\s/.test(source[index] ?? '')) index += 1

      const quote = source[index]
      if (quote === '"' || quote === "'") {
        index += 1
        const valueStart = index
        while (index < source.length && source[index] !== quote) index += 1
        if (index >= source.length) {
          throw new Error('Invalid analytics script attribute value')
        }
        value = source.slice(valueStart, index)
        index += 1
      } else {
        const valueStart = index
        while (index < source.length && !/\s/.test(source[index])) index += 1
        value = source.slice(valueStart, index)
        if (!value) {
          throw new Error('Invalid analytics script attribute value')
        }
      }
    }

    attributes.push({ name: rawName.toLowerCase(), value })
  }

  return attributes
}

export function resolveWebsiteRepositoryLinks(repositoryUrl: string): WebsiteRepositoryLinks {
  const blobUrl = `${repositoryUrl}/blob/${REPOSITORY_DOCS_BRANCH}`

  return {
    github: repositoryUrl,
    docs: `${repositoryUrl}#readme`,
    docsZh: `${blobUrl}/README.zh-CN.md`,
    cloudflare: {
      zh: `${blobUrl}/docs/cloudflare-workers-deploy.zh-CN.md`,
      en: `${blobUrl}/docs/cloudflare-workers-deploy.md`,
    },
    docker: `${blobUrl}/README.zh-CN.md#快速部署`,
    license: `${blobUrl}/LICENSE`,
  }
}

export function resolveWebsiteDeployment(env: WebsiteEnv = {}): WebsiteDeployment {
  const basePath = normalizeBasePath(env.RENEWLET_WEBSITE_BASE_PATH)
  const baseUrl = normalizeBaseUrl(env.RENEWLET_WEBSITE_BASE_URL)
  // 仓库和 analytics 都是公开构建元数据；只读显式 env，
  // 避免把本地 token remote 写进静态产物。
  const repositoryUrl = normalizePublicHttpUrl(env.RENEWLET_WEBSITE_REPOSITORY_URL, DEFAULT_REPOSITORY_URL)

  return {
    basePath,
    baseUrl,
    repositoryLinks: resolveWebsiteRepositoryLinks(repositoryUrl),
    repositoryUrl,
    analyticsScript: resolveWebsiteAnalyticsScript(env.RENEWLET_WEBSITE_ANALYTICS_SCRIPT),
    // Vite base 需要尾随斜杠；空子路径必须回到根路径，否则 build 后资源会变成相对路径。
    viteBase: basePath ? `${basePath}/` : '/',
  }
}

export function websiteUrl(deployment: Pick<WebsiteDeployment, 'baseUrl'>, path = '') {
  const normalizedPath = path.replace(/^\/+/, '')
  return normalizedPath ? `${deployment.baseUrl}/${normalizedPath}` : `${deployment.baseUrl}/`
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function normalizeBooleanScriptAttribute(attribute: ScriptAttribute) {
  if (attribute.value !== null && attribute.value !== '' && attribute.value.toLowerCase() !== attribute.name) {
    throw new Error(`Invalid boolean analytics script attribute: ${attribute.name}`)
  }

  return attribute.name
}

function normalizeValuedScriptAttribute(attribute: ScriptAttribute) {
  if (attribute.value === null) {
    throw new Error(`Analytics script attribute requires a value: ${attribute.name}`)
  }

  return `${attribute.name}="${escapeHtmlAttribute(attribute.value)}"`
}

function normalizeScriptSrc(attribute: ScriptAttribute) {
  if (!attribute.value) {
    throw new Error('Analytics script src is required')
  }

  const url = parseHttpUrl(attribute.value, 'analytics script URL')
  url.hash = ''
  return `src="${escapeHtmlAttribute(url.toString())}"`
}

function normalizeTypeAttribute(attribute: ScriptAttribute) {
  if (!attribute.value) {
    throw new Error('Analytics script type requires a value')
  }

  const normalizedType = attribute.value.toLowerCase()
  if (!['text/javascript', 'application/javascript', 'module'].includes(normalizedType)) {
    throw new Error(`Unsupported analytics script type: ${attribute.value}`)
  }

  return `type="${escapeHtmlAttribute(normalizedType)}"`
}

function normalizeScriptAttribute(attribute: ScriptAttribute) {
  if (attribute.name.startsWith('on')) {
    throw new Error(`Analytics script event attributes are not allowed: ${attribute.name}`)
  }
  if (attribute.name === 'src') return normalizeScriptSrc(attribute)
  if (BOOLEAN_ANALYTICS_SCRIPT_ATTRIBUTES.has(attribute.name)) return normalizeBooleanScriptAttribute(attribute)
  if (attribute.name === 'type') return normalizeTypeAttribute(attribute)
  if (attribute.name.startsWith('data-')) return normalizeValuedScriptAttribute(attribute)
  if (VALUED_ANALYTICS_SCRIPT_ATTRIBUTES.has(attribute.name)) return normalizeValuedScriptAttribute(attribute)

  throw new Error(`Unsupported analytics script attribute: ${attribute.name}`)
}

export function resolveWebsiteAnalyticsScript(rawScript: string | undefined) {
  const script = rawScript?.trim()
  if (!script) return ''

  const lowerScript = script.toLowerCase()
  if (!lowerScript.startsWith('<script') || !lowerScript.endsWith('</script>')) {
    throw new Error('Analytics script must be a single <script> element')
  }

  let openingEnd = -1
  let quote: string | null = null
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      openingEnd = index
      break
    }
  }

  if (openingEnd === -1) {
    throw new Error('Analytics script opening tag is invalid')
  }

  const openingTag = script.slice(0, openingEnd + 1)
  const body = script.slice(openingEnd + 1, -'</script>'.length)
  if (body.trim()) {
    throw new Error('Analytics script must not contain inline code')
  }

  const tagSuffix = openingTag.slice('<script'.length, -1)
  if (tagSuffix && !/^\s/.test(tagSuffix)) {
    throw new Error('Analytics script tag is invalid')
  }

  const attributes = parseScriptAttributes(tagSuffix)
  if (!attributes.some((attribute) => attribute.name === 'src')) {
    throw new Error('Analytics script src is required')
  }

  const seenAttributes = new Set<string>()
  for (const attribute of attributes) {
    if (seenAttributes.has(attribute.name)) {
      throw new Error(`Duplicate analytics script attribute: ${attribute.name}`)
    }
    seenAttributes.add(attribute.name)
  }

  // 这是公开 HTML 注入边界；变量只允许表达一个外链脚本，不能退化成任意 HTML 直出。
  const normalizedAttributes = attributes.map(normalizeScriptAttribute).sort((left, right) => {
    const leftIndex = ANALYTICS_SCRIPT_ATTRIBUTE_ORDER.indexOf(left.split('=')[0])
    const rightIndex = ANALYTICS_SCRIPT_ATTRIBUTE_ORDER.indexOf(right.split('=')[0])
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? ANALYTICS_SCRIPT_ATTRIBUTE_ORDER.length : leftIndex) -
        (rightIndex === -1 ? ANALYTICS_SCRIPT_ATTRIBUTE_ORDER.length : rightIndex)
      )
    }
    return left.localeCompare(right)
  })

  return `<script ${normalizedAttributes.join(' ')}></script>`
}

export function renderRobotsTxt(deployment: WebsiteDeployment) {
  return `User-agent: *
Allow: /

Sitemap: ${websiteUrl(deployment, 'sitemap.xml')}
`
}

export function renderSitemapXml(deployment: WebsiteDeployment) {
  const rootUrl = websiteUrl(deployment)
  const enUrl = websiteUrl(deployment, 'en/')

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${rootUrl}</loc>
    <lastmod>${SITEMAP_LASTMOD}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${rootUrl}" />
    <xhtml:link rel="alternate" hreflang="en" href="${enUrl}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${rootUrl}" />
  </url>
  <url>
    <loc>${enUrl}</loc>
    <lastmod>${SITEMAP_LASTMOD}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${rootUrl}" />
    <xhtml:link rel="alternate" hreflang="en" href="${enUrl}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${rootUrl}" />
  </url>
</urlset>
`
}

export function replaceWebsiteMetadataPlaceholders(
  html: string,
  deployment: WebsiteDeployment,
  metadata: WebsiteMetadata,
) {
  // HTML 模板里的占位符由构建脚本一次性替换，避免运行时 JS 才补 SEO/分享元数据。
  const replacements: Record<string, string> = {
    '%RENEWLET_WEBSITE_URL%': websiteUrl(deployment),
    '%RENEWLET_WEBSITE_EN_URL%': websiteUrl(deployment, 'en/'),
    '%RENEWLET_WEBSITE_LOGO_URL%': websiteUrl(deployment, 'assets/renewlet/logo.svg'),
    '%RENEWLET_WEBSITE_DASHBOARD_ZH_URL%': websiteUrl(deployment, 'assets/renewlet/images/dashboard-zh.png'),
    '%RENEWLET_WEBSITE_DASHBOARD_EN_URL%': websiteUrl(deployment, 'assets/renewlet/images/dashboard-en.png'),
    '%RENEWLET_WEBSITE_SOFTWARE_VERSION%': metadata.softwareVersion,
    '%RENEWLET_WEBSITE_REPOSITORY_URL%': deployment.repositoryUrl,
    '%RENEWLET_WEBSITE_LICENSE_URL%': deployment.repositoryLinks.license,
    '%RENEWLET_WEBSITE_ANALYTICS_SCRIPT%': deployment.analyticsScript,
  }

  return Object.entries(replacements).reduce(
    (result, [placeholder, value]) => result.replaceAll(placeholder, value),
    html,
  )
}
