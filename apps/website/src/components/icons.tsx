import type { SVGProps } from 'react'

export function RenewletLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-label="Renewlet" fill="none" viewBox="0 0 150 28" xmlns="http://www.w3.org/2000/svg" {...props}>
      <g transform="translate(1 5)">
        <rect fill="#F8FAFC" height="5.2" rx="2.6" width="18" y="2.4" />
        <circle cx="25" cy="5" fill="#10B981" r="3.2" />
        <rect fill="#10B981" height="4" opacity=".78" rx="2" width="21" x="3" y="14" />
      </g>
      <text
        fill="#F8FAFC"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize="21"
        fontWeight="800"
        letterSpacing="-.5"
        x="42"
        y="21"
      >
        Renewlet
      </text>
    </svg>
  )
}

export function GridPattern(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" {...props}>
      <defs>
        <pattern height="80" id="hero-grid" patternUnits="userSpaceOnUse" width="80" x="50%" y="-1">
          <path d="M.5 200V.5H200" fill="none" />
        </pattern>
      </defs>
      <rect fill="url(#hero-grid)" height="100%" strokeWidth="0" width="100%" />
    </svg>
  )
}
