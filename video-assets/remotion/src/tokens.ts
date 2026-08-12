// Qomicex design tokens — derived from the product design system
// (src/index.css CSS variables + tailwind.config.js), re-skinned for the
// video while staying faithful to the app's dark glassmorphism + green accent.

export const TOKENS = {
  // surfaces
  bg: 'hsl(230 20% 6%)',
  card: 'hsl(228 18% 10%)',
  cardBg70: 'hsl(228 18% 10% / 0.7)',
  secondary: 'hsl(228 18% 14%)',
  popover: 'hsl(228 18% 10%)',
  // text
  fg: 'hsl(220 20% 93%)',
  fg2: 'hsl(220 20% 80%)',
  muted: 'hsl(228 8% 55%)',
  // accents
  primary: 'hsl(142 71% 48%)',
  primaryDim: 'hsl(142 71% 48% / 0.25)',
  primaryGlow: 'rgba(76, 208, 143, 0.5)',
  border: 'hsl(228 14% 21%)',
  ring: 'hsl(142 71% 48%)',
  // status
  danger: 'hsl(0 84% 60%)',
  warning: 'hsl(38 92% 60%)',
  // radius (product --radius 0.625rem=10px; xl=12px, lg=10px, md=8px)
  radiusSm: 8,
  radius: 10,
  radiusXl: 12,
  radius2xl: 16,
} as const;

// fonts — product uses a system sans stack; captions/annotations mirror the
// app's mono usage for status lines.
export const FONT_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
export const FONT_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// motion personality — brand on the energy/tonality axes:
// energy: medium-high (gaming launcher), tonality: playful-but-clean.
// Preset base: 活力大胆 (18f, bezier(0.16,1,0.3,1), overshoot 1.12, squash 0.25)
// tempered toward 精致高端 for the hero-card macro (slower, no squash on macro).
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_POP = [0.2, 1.25, 0.3, 1] as const; // spring overshoot (rise)
export const EASE_RESET = [0.4, 0, 0.3, 1.05] as const; // compress on touchdown
export const EASE_FLY = [0.3, 0, 0.2, 1] as const; // dive
export const EASE_SETTLE = [0.3, 0, 0.25, 1.15] as const; // overshoot settle
export const EASE_CAM = [0.35, 0, 0.2, 1] as const; // push-in
