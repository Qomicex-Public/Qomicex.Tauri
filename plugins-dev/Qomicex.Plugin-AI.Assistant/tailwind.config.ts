import type { Config } from 'tailwindcss'
import pluginUiPreset from '@qomicex/plugin-ui/tailwind-preset'

export default {
  presets: [pluginUiPreset],
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
} satisfies Config
