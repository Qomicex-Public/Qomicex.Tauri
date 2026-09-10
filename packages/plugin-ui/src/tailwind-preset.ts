import type { Config } from 'tailwindcss'

export default {
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        'sidebar-indicator': {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
        'zoom-fade-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(1rem)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'label-swap': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'focus-glow': {
          '0%': { boxShadow: '0 0 0 0 hsl(var(--ring) / 0.5)' },
          '70%': { boxShadow: '0 0 0 4px hsl(var(--ring) / 0.12)' },
          '100%': { boxShadow: '0 0 0 6px hsl(var(--ring) / 0)' },
        },
      },
      animation: {
        'sidebar-indicator': 'sidebar-indicator 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'zoom-fade-in': 'zoom-fade-in calc(150ms * var(--anim-duration-multiplier, 1)) cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-right': 'slide-in-right calc(200ms * var(--anim-duration-multiplier, 1)) cubic-bezier(0.16, 1, 0.3, 1)',
        'label-swap': 'label-swap calc(180ms * var(--anim-duration-multiplier, 1)) cubic-bezier(0.16, 1, 0.3, 1)',
        'focus-glow': 'focus-glow calc(450ms * var(--anim-duration-multiplier, 1)) cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
} satisfies Omit<Config, 'content'>
