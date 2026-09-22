import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { links, localizedUrl } from '../../content/site'
import { DeployDialog } from './DeployDialog'

describe('DeployDialog', () => {
  it('shows Renewlet deployment links', () => {
    render(<DeployDialog locale="zh" onOpenChange={() => {}} open />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /选择 Renewlet 部署方式/i })).toBeInTheDocument()
    const dockerLink = screen.getByRole('link', { name: /Docker 单容器/i })
    const cloudflareLink = screen.getByRole('link', { name: /Cloudflare Workers/i })

    expect(dockerLink).toBeInTheDocument()
    expect(dockerLink).toHaveAttribute('href', links.docker)
    expect(cloudflareLink).toHaveAttribute('href', localizedUrl(links.cloudflare, 'zh'))
    for (const link of [dockerLink, cloudflareLink]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    expect(screen.queryByRole('link', { name: /源码仓库/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /官网静态部署/i })).not.toBeInTheDocument()
  })

  it('closes through the accessible close button', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<DeployDialog locale="en" onOpenChange={onOpenChange} open />)

    await user.click(screen.getByRole('button', { name: /Close/i }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
