import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { TOKENS } from '../tokens';

const DARK_SRC = 'textures/live/settings-full.png';
const LIGHT_SRC = 'textures/live/settings-light-full.png';
const PAGE_H = 1080;

/**
 * SceneThemeSweep — crossfade from dark theme to light theme on the settings
 * page, with a green sweep band and the theme toggle highlight.
 */
export const SceneThemeSweep: React.FC = () => {
  const frame = useCurrentFrame();

  // dark → light crossfade (frames 8-30)
  const crossfade = interpolate(frame, [8, 30], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.4, 0, 0.3, 1),
  });

  // green sweep band
  const sweepX = interpolate(frame, [4, 28], [-400, 2320], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.35, 0, 0.25, 1),
  });
  const sweepOpacity = interpolate(frame, [4, 8, 24, 28], [0, 0.18, 0.18, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // entrance / exit fade
  const fadeIn = interpolate(frame, [0, 3], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(frame, [52, 60], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg, opacity: fadeIn * fadeOut }}>
      {/* dark layer (bottom) */}
      <Img
        src={staticFile(DARK_SRC)}
        style={{ position: 'absolute', width: 1920, height: PAGE_H }}
      />

      {/* light layer (top, crossfaded) */}
      <div style={{ position: 'absolute', inset: 0, opacity: crossfade }}>
        <Img
          src={staticFile(LIGHT_SRC)}
          style={{ position: 'absolute', width: 1920, height: PAGE_H }}
        />
      </div>

      {/* green sweep band */}
      {sweepOpacity > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: sweepX - 200,
            width: 400,
            background: 'linear-gradient(90deg, rgba(76,208,143,0), rgba(76,208,143,0.9) 50%, rgba(76,208,143,0))',
            opacity: sweepOpacity,
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
