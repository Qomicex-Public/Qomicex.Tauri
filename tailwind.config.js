import preset from '@qomicex/plugin-ui/tailwind-preset'

/**
 * 宿主（主仓库）Tailwind 配置。
 *
 * 颜色 / 圆角 / keyframes / animation 由 `@qomicex/plugin-ui/tailwind-preset`
 * 单一提供（`presets` 会与本地 `theme.extend` 合并），不再各抄一份 —— 此前两份
 * 拷贝已经漂移（`borderRadius.xl` 为 +2px，preset 为 +4px），宿主与插件包对同一个
 * `rounded-xl` 定义不同。统一取 preset 的 +4px。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./packages/plugin-ui/src/**/*.{ts,tsx}",
    "./node_modules/@qomicex/plugin-ui/dist/**/*.js",
  ],
  darkMode: "class",
  presets: [preset],
  theme: {
    extend: {
      // preset 不含缓动曲线（插件包内部使用 CSS 直接书写），仅宿主侧保留。
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
