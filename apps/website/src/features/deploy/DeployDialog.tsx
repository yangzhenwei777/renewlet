import * as Dialog from '@radix-ui/react-dialog'
import { ExternalLink, X } from 'lucide-react'

import { deployOptions, localizedUrl, text, type DeployOption, type Locale } from '../../content/site'
import { externalLinkProps } from '../../lib/external-link'

type DeployDialogProps = {
  locale: Locale
  open: boolean
  onOpenChange: (open: boolean) => void
}

function DeployOptionCard({ locale, option }: { locale: Locale; option: DeployOption }) {
  const Icon = option.icon

  return (
    <a
      className="group grid gap-3 rounded-xl border border-white/10 bg-zinc-900/60 p-4 text-left transition hover:border-emerald-300/40 hover:bg-zinc-900"
      href={localizedUrl(option.href, locale)}
      {...externalLinkProps}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-emerald-300">
          <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
        </span>
        <ExternalLink
          aria-hidden="true"
          className="h-4 w-4 text-zinc-500 transition group-hover:text-emerald-200"
          strokeWidth={1.6}
        />
      </span>
      <span>
        <span className="block text-base font-semibold text-zinc-100">{text(option.title, locale)}</span>
        <span className="mt-1 block text-sm leading-6 text-zinc-400">{text(option.body, locale)}</span>
      </span>
      <span className="text-sm font-medium text-emerald-200">{text(option.action, locale)}</span>
    </a>
  )
}

export function DeployDialog({ locale, onOpenChange, open }: DeployDialogProps) {
  const title = locale === 'zh' ? '选择 Renewlet 部署方式' : 'Choose how to deploy Renewlet'
  const description =
    locale === 'zh'
      ? '按你的运行环境选择 Docker 单容器，或者部署到 Cloudflare Workers。'
      : 'Choose the single Docker container, or deploy the Cloudflare Workers runtime.'

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-10 bg-black/60 backdrop-blur-sm data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          className="fixed left-3 right-3 top-4 z-20 mx-auto max-h-[calc(100vh-2rem)] w-auto max-w-3xl overflow-y-auto rounded-lg border border-white/10 bg-zinc-950 pt-0 data-[state=closed]:animate-close-scale-out-fade data-[state=open]:animate-open-scale-in-fade sm:left-0 sm:right-0 sm:top-[calc(100vh-92%)]"
          data-dialog="deploy"
        >
          <div className="relative border-b border-white/10 px-5 py-6 sm:px-6">
            <div className="mx-auto flex h-16 w-16 animate-slide-fade-in items-center justify-center rounded-full bg-zinc-900/30 shadow-lg shadow-emerald-700/20 ring-1 ring-white/10">
              <ExternalLink className="text-zinc-400" size={34} strokeWidth={0.9} />
            </div>
            <Dialog.Title className="mt-5 text-center text-2xl font-bold text-zinc-100">{title}</Dialog.Title>
            <Dialog.Description
              className="mx-auto mt-2 max-w-lg text-center text-sm leading-6 text-zinc-400"
            >
              {description}
            </Dialog.Description>
          </div>

          <div className="grid gap-3 px-5 py-5 sm:grid-cols-2 sm:px-6">
            {/* 弹窗只放产品部署入口；官网自身的 Pages/Docker 静态部署留在工程 README，避免 CTA 重复。 */}
            {deployOptions.map((option) => (
              <DeployOptionCard key={option.key} locale={locale} option={option} />
            ))}
          </div>

          <Dialog.Close asChild>
            <button
              aria-label={locale === 'zh' ? '关闭' : 'Close'}
              className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded bg-zinc-950 text-zinc-400 transition duration-200 ease-in-out hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              type="button"
            >
              <X aria-hidden="true" className="h-5 w-5" strokeWidth={1.5} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
