import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/utils'

type GlowButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode
  innerClassName?: string
}

export function GlowButton({
  children,
  className,
  innerClassName,
  type = 'button',
  ...props
}: GlowButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'group relative rounded-full p-px text-sm/6 text-zinc-400 duration-300 hover:text-zinc-100 hover:shadow-glow',
        className,
      )}
      {...props}
    >
      {/* 装饰层只做 hover 光效，真实点击/焦点仍落在 button，本组件不能包成链接外壳。 */}
      <span className="absolute inset-0 overflow-hidden rounded-full">
        <span className="absolute inset-0 rounded-full bg-[image:radial-gradient(75%_100%_at_50%_0%,rgba(56,189,248,0.6)_0%,rgba(56,189,248,0)_75%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
      </span>
      <span
        className={cn(
          'relative z-10 block rounded-full bg-zinc-950 px-4 py-1.5 ring-1 ring-white/10',
          innerClassName,
        )}
      >
        {children}
      </span>
      <span className="absolute -bottom-0 left-[1.125rem] h-px w-[calc(100%-2.25rem)] bg-gradient-to-r from-cyan-400/0 via-cyan-400/90 to-cyan-400/0 transition-opacity duration-500 group-hover:opacity-40" />
    </button>
  )
}
