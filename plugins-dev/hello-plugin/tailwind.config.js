import preset from '@qomicex/plugin-ui/tailwind-preset'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/plugin-ui/src/**/*.{ts,tsx}'],
  presets: [preset],
  darkMode: 'class',
}
