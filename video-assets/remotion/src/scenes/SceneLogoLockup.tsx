import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { TOKENS, FONT_SANS } from '../tokens';

/**
 * SceneLogoLockup — Logo缩进字标锁定
 * 序列结尾，主软件图标优雅缩进，与字标锁定并排，
 * 在导航栏中形成一个统一、紧凑的Logo整体。
 */
export const SceneLogoLockup: React.FC = () => {
  const frame = useCurrentFrame();

  // Phase 1: Logo shrinks and moves to nav bar position (frames 0-60)
  const shrinkProgress = interpolate(frame, [0, 60], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Logo position: from center to nav bar left
  const logoScale = interpolate(shrinkProgress, [0, 1], [1.5, 0.6]);
  const logoX = interpolate(shrinkProgress, [0, 1], [960, 120]);
  const logoY = interpolate(shrinkProgress, [0, 1], [540, 50]);

  // Wordmark appears after logo settles
  const wordmarkIn = interpolate(frame, [50, 80], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const wordmarkX = interpolate(wordmarkIn, [0, 1], [logoX + 80, logoX + 80]);
  const wordmarkOpacity = wordmarkIn;

  // Nav bar background fades in
  const navIn = interpolate(frame, [40, 70], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Tagline appears
  const taglineIn = interpolate(frame, [90, 120], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Subtle glow on logo
  const glowPulse = Math.sin(frame * 0.05) * 0.1 + 0.3;

  // Exit fade
  const exitOpacity = interpolate(frame, [150, 180], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg, opacity: exitOpacity }}>
      {/* Nav bar background */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 100,
          background: `linear-gradient(to bottom, rgba(0,0,0,0.8), rgba(0,0,0,0.4))`,
          opacity: navIn,
          borderBottom: `1px solid rgba(255,255,255,0.05)`,
        }}
      />

      {/* Logo */}
      <div
        style={{
          position: 'absolute',
          left: logoX - 40,
          top: logoY - 48,
          width: 80,
          height: 96,
          transform: `scale(${logoScale})`,
          transformOrigin: 'center center',
        }}
      >
        <Img
          src={staticFile('textures/logo.png')}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: `drop-shadow(0 0 ${20 * glowPulse}px ${TOKENS.primaryDim})`,
          }}
        />
      </div>

      {/* Wordmark */}
      <div
        style={{
          position: 'absolute',
          left: wordmarkX,
          top: logoY - 12,
          opacity: wordmarkOpacity,
          transform: `translateY(${(1 - wordmarkIn) * 10}px)`,
        }}
      >
        <span
          style={{
            fontFamily: FONT_SANS,
            fontSize: 32,
            fontWeight: 700,
            color: TOKENS.fg,
            letterSpacing: '0.08em',
          }}
        >
          QOMICEX
        </span>
      </div>

      {/* Tagline */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 120,
          textAlign: 'center',
          opacity: taglineIn,
          transform: `translateY(${(1 - taglineIn) * 20}px)`,
        }}
      >
        <span
          style={{
            fontFamily: FONT_SANS,
            fontSize: 24,
            fontWeight: 500,
            color: TOKENS.fg2,
            letterSpacing: '0.15em',
          }}
        >
          YOUR MINECRAFT, YOUR WAY
        </span>
      </div>

      {/* Decorative line */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 100,
          width: interpolate(taglineIn, [0, 1], [0, 300]),
          height: 2,
          transform: 'translateX(-50%)',
          background: `linear-gradient(90deg, transparent, ${TOKENS.primary}, transparent)`,
        }}
      />
    </AbsoluteFill>
  );
};
