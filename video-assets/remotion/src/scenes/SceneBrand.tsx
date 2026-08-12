import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { TOKENS, FONT_MONO, FONT_SANS } from '../tokens';

/**
 * SceneBrand — 字距淡入成型效果 (letterspace-materialize)
 * 镜头平稳后，切入品牌标识环节。软件图标与标题以精准的字间距淡入视野，
 * 彰显品牌标志性的极简美学。
 */
export const SceneBrand: React.FC = () => {
  const frame = useCurrentFrame();

  // Logo fade in with scale
  const logoIn = interpolate(frame, [0, 30], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const logoScale = interpolate(logoIn, [0, 1], [0.6, 1]);
  const logoBlur = interpolate(logoIn, [0, 1], [8, 0]);

  // Title letterspace-materialize
  // Each letter appears with expanding letter-spacing
  const title = 'QOMICEX';
  const letterElements = title.split('').map((char, i) => {
    const letterDelay = 15 + i * 4; // staggered by 4 frames
    const letterIn = interpolate(frame, [letterDelay, letterDelay + 20], [0, 1], {
      extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    });
    
    // Letter-spacing starts wide and settles to final
    const letterSpacing = interpolate(letterIn, [0, 1], [40, 12]);
    const letterOpacity = interpolate(letterIn, [0, 1], [0, 1]);
    const letterY = interpolate(letterIn, [0, 1], [10, 0]);
    
    return { char, letterSpacing, letterOpacity, letterY, index: i };
  });

  // Subtitle fade in
  const subtitleIn = interpolate(frame, [60, 80], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Decorative line
  const lineIn = interpolate(frame, [45, 70], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const lineWidth = interpolate(lineIn, [0, 1], [0, 200]);

  // Exit fade
  const exitOpacity = interpolate(frame, [100, 120], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg, opacity: exitOpacity }}>
      {/* Centered brand group */}
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          {/* Logo */}
          <div
            style={{
              opacity: logoIn,
              transform: `scale(${logoScale})`,
              filter: `blur(${logoBlur}px)`,
              marginBottom: 24,
            }}
          >
            <Img
              src={staticFile('textures/logo.png')}
              style={{
                width: 120,
                height: 144,
                objectFit: 'contain',
                display: 'block',
                margin: '0 auto',
              }}
            />
          </div>

          {/* Title with letterspace-materialize */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            {letterElements.map(({ char, letterSpacing, letterOpacity, letterY }) => (
              <span
                key={`${char}-${letterSpacing}`}
                style={{
                  fontFamily: FONT_SANS,
                  fontSize: 72,
                  fontWeight: 700,
                  color: TOKENS.fg,
                  letterSpacing: `${letterSpacing}px`,
                  opacity: letterOpacity,
                  transform: `translateY(${letterY}px)`,
                  display: 'inline-block',
                }}
              >
                {char}
              </span>
            ))}
          </div>

          {/* Decorative line */}
          <div
            style={{
              width: lineWidth,
              height: 2,
              background: `linear-gradient(90deg, transparent, ${TOKENS.primary}, transparent)`,
              margin: '0 auto 16px',
              opacity: lineIn,
            }}
          />

          {/* Subtitle */}
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 16,
              letterSpacing: '0.3em',
              color: TOKENS.muted,
              textTransform: 'uppercase',
              opacity: subtitleIn,
            }}
          >
            MINECRAFT LAUNCHER
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
