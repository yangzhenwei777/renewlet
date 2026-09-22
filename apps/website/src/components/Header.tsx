import { links, locales, type Locale, copy, text } from '../content/site'
import { externalLinkProps } from '../lib/external-link'
import { websitePath } from '../lib/site-path'
import { RenewletLogo } from './icons'

type HeaderProps = {
  locale: Locale
  onLocaleChange: (locale: Locale) => void
}

export function Header({ locale, onLocaleChange }: HeaderProps) {
  const nextLocale: Locale = locale === 'zh' ? 'en' : 'zh'

  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <div className="relative flex justify-center">
        <div className="mx-4 w-full max-w-7xl">
          <nav aria-label="Global" className="flex min-h-20 items-center justify-between px-4 py-3">
            <div className="flex lg:flex-1">
              {/* GitHub Pages 仓库页部署在 Vite base 下，品牌链接不能写死域名根路径。 */}
              <a aria-label="Renewlet home" href={websitePath()}>
                <RenewletLogo className="h-6 w-auto sm:h-7" />
              </a>
            </div>
            <ul className="flex flex-1 items-center justify-end gap-4 text-xs font-medium text-zinc-300 sm:gap-6 sm:text-sm">
              {/* 文档/GitHub 是导航链接，语言切换是动作按钮；不要再包成 tab 或 segmented control。 */}
              <li>
                <a
                  className="transition hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/45"
                  href={links.docsZh}
                  {...externalLinkProps}
                >
                  {text(copy.nav.blog, locale)}
                </a>
              </li>
              <li>
                <a
                  className="transition hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/45"
                  href={links.github}
                  {...externalLinkProps}
                >
                  {text(copy.nav.github, locale)}
                </a>
              </li>
              <li>
                <button
                  aria-label={locales[nextLocale].ariaLabel}
                  className="inline-flex h-8 min-w-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-950/20 px-2 text-[11px] font-semibold tracking-[0.08em] text-zinc-300 transition hover:border-emerald-300/25 hover:bg-white/[0.045] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/45 sm:min-w-10 sm:px-2.5 sm:text-xs"
                  onClick={() => onLocaleChange(nextLocale)}
                  type="button"
                >
                  {locales[nextLocale].label}
                </button>
              </li>
            </ul>
          </nav>
        </div>
      </div>
    </header>
  )
}
