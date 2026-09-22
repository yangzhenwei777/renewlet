import type { ComponentType, SVGProps } from 'react'
import { Cloud, Container, ScrollText } from 'lucide-react'

import { copy, links, localizedUrl, text, type Locale } from '../content/site'
import { externalLinkProps } from '../lib/external-link'

type FooterProps = {
  locale: Locale
}

type FooterIcon = ComponentType<SVGProps<SVGSVGElement> & { strokeWidth?: number }>

// 当前 lucide-react 没有官方 GitHub mark；内联 SVG 继承 currentColor，才能和其它 footer 线性图标保持同一 hover 体系。
function GitHubLogo({ strokeWidth, ...props }: SVGProps<SVGSVGElement> & { strokeWidth?: number }) {
  return (
    <svg fill="currentColor" strokeWidth={strokeWidth} viewBox="0 0 24 24" {...props}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.14c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18A10.95 10.95 0 0 1 12 6.06c.98 0 1.94.13 2.86.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.42-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.15c0 .31.21.67.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

function FooterLink({
  href,
  icon: Icon,
  label,
}: {
  href: string
  icon: FooterIcon
  label: string
}) {
  return (
    <a
      aria-label={label}
      className="group relative flex h-6 w-6 items-center justify-center text-zinc-400 transition hover:text-zinc-300"
      href={href}
      {...externalLinkProps}
    >
      <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
      {/* Tooltip 只给视觉用户确认 icon-only 入口；读屏继续依赖链接自身 aria-label。 */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 translate-y-1 rounded-md border border-white/10 bg-zinc-950/92 px-2.5 py-1.5 text-xs font-medium text-zinc-200 opacity-0 shadow-xl shadow-black/30 backdrop-blur transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
      >
        {label}
      </span>
    </a>
  )
}

export function Footer({ locale }: FooterProps) {
  return (
    <footer className="isolate mx-auto max-w-7xl p-6 pb-16 pt-16 md:pb-12 lg:px-8" data-section="footer" id="footer">
      <div className="border-t border-white/10 pt-4 md:flex md:items-center md:justify-between">
        <div className="flex justify-center space-x-6 md:order-2">
          <FooterLink href={links.github} icon={GitHubLogo} label="GitHub" />
          <FooterLink href={links.docker} icon={Container} label="Docker" />
          <FooterLink href={localizedUrl(links.cloudflare, locale)} icon={Cloud} label="Cloudflare" />
          <FooterLink href={links.license} icon={ScrollText} label="License" />
        </div>

        <div className="mt-8 text-center text-xs font-medium leading-5 text-zinc-400 md:order-1 md:mt-0 md:text-left">
          <p>{text(copy.footer.copyright, locale)}</p>
        </div>
      </div>
      <div className="mt-4 w-full text-xs leading-5 text-zinc-500 max-md:text-center md:max-w-[60%]">
        <p className="max-md:px-1">{text(copy.footer.note, locale)}</p>
      </div>
    </footer>
  )
}
