// 官网外链统一新开窗口并切断 opener，避免部署/文档链接能反向控制当前页面。
export const externalLinkProps = {
  rel: 'noopener noreferrer',
  target: '_blank',
} as const
