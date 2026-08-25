import preset from '@qomicex/plugin-ui/tailwind-preset'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', './node_modules/@qomicex/plugin-ui/dist/**/*.{js,ts,tsx}'],
  presets: [preset],
  darkMode: 'class',
}
