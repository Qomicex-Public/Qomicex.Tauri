// Settings page (en; batch0 covers category nav + appearance core, rest filled by migration batches)
export default {
  category: {
    launcher: 'Launcher',
    java: 'Java Runtime',
    plugins: 'Plugins',
    appearance: 'Appearance',
    toolbox: 'Toolbox',
    logs: 'Logs',
    about: 'About',
    debug: 'Debug',
  },
  appearance: {
    title: 'Interface',
    language: 'Language',
    theme: 'Theme',
    dark: 'Dark',
    light: 'Light',
    animations: 'Page animations',
    animationsDesc: 'Enables transition animations for page switches and dialogs',
    animationSpeed: 'Animation speed',
    slow: 'Slow',
    normal: 'Normal',
    fast: 'Fast',
    maxFrameRate: 'Max frame rate',
    maxFrameRateUnlimited: 'Unlimited',
    maxFrameRateDesc: 'Limits the frame rate of the launcher UI to reduce resource usage. Unlimited uses the display refresh rate.',
  },
} as const
