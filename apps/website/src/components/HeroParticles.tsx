import Particles from '@tsparticles/react'

// 粒子只做首屏背景氛围，pointer-events 由容器禁用，避免遮挡部署按钮和语言切换。
const particlesOptions = {
  particles: {
    number: { value: 150, density: { enable: true } },
    color: { value: '#ffffff' },
    shape: { type: 'circle' },
    opacity: { value: { min: 0.2, max: 0.4 } },
    size: { value: { min: 1, max: 2 } },
    move: {
      enable: true,
      speed: { min: 0.35, max: 0.75 },
      direction: 'top' as const,
      random: true,
      straight: true,
      outModes: { default: 'out' as const },
    },
  },
  retina_detect: true,
}

export function HeroParticles() {
  return (
    <Particles
      // 负向 top 把粒子云移出主标题阅读区，保留动效但不影响文案对比度。
      className="pointer-events-none absolute -top-36 left-1/2 h-[32rem] w-full -translate-x-1/2 -translate-y-1/2 overflow-hidden lg:w-[60rem]"
      id="tsparticles"
      options={particlesOptions}
    />
  )
}
