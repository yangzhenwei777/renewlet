export function websitePath(path = '', baseUrl = import.meta.env.BASE_URL) {
  const base = baseUrl ? baseUrl : '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  const normalizedPath = path.replace(/^\/+/, '')

  // 官网可能部署在 GitHub Pages/Cloudflare Pages 子路径下；所有站内资源都必须经 BASE_URL 拼接。
  return `${normalizedBase}${normalizedPath}`
}
