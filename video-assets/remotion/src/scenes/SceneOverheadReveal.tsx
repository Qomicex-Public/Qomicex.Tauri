import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { TOKENS } from '../tokens';

/**
 * SceneOverheadReveal — 顶视运镜 + 倾斜揭示
 * 从屏幕右下角发起倾斜揭示，平稳滑向中心。
 * 只展示Dashboard界面，不添加额外UI元素。
 */
export const SceneOverheadReveal: React.FC = () => {
  const frame = useCurrentFrame();

  // Camera animation: start from bottom-right, slide to center
  const revealProgress = interpolate(frame, [0, 90], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.bezier(0.25, 0.1, 0.25, 1),
  });

  // Camera position
  const startX = 1920 + 400;
  const startY = 1080 + 300;
  const endX = 960;
  const endY = 540;
  const cx = interpolate(revealProgress, [0, 1], [startX, endX]);
  const cy = interpolate(revealProgress, [0, 1], [startY, endY]);

  // Zoom
  const zoom = interpolate(revealProgress, [0, 1], [0.3, 1.0]);

  // Tilt angles
  const rotX = interpolate(revealProgress, [0, 1], [25, 0]);
  const rotY = interpolate(revealProgress, [0, 1], [-30, 0]);
  const rotZ = interpolate(revealProgress, [0, 1], [5, 0]);

  // Perspective
  const persp = interpolate(revealProgress, [0, 1], [800, 1400]);

  // Green glow during reveal
  const glowOpacity = interpolate(frame, [30, 60, 90], [0, 0.3, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // Vignette
  const vignette = interpolate(revealProgress, [0, 1], [0.6, 0.2]);

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg }}>
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            perspective: `${persp * zoom}px`,
            perspectiveOrigin: '960px 540px',
          }}
        >
          <div
            style={{
              position: 'absolute',
              width: 1920,
              height: 1080,
              zoom,
              transform: `translate(${960 / zoom - cx}px, ${540 / zoom - cy}px) rotateY(${rotY}deg) rotateX(${rotX}deg) rotateZ(${rotZ}deg)`,
              transformOrigin: `${cx}px ${cy}px`,
              transformStyle: 'preserve-3d',
            }}
          >
            <Img
              src={staticFile('textures/live/dashboard-full.png')}
              style={{ position: 'absolute', width: 1920, height: 1080 }}
            />
          </div>
        </div>
      </AbsoluteFill>

      {/* Green glow */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(600px 400px at 50% 50%, rgba(76,208,143,${glowOpacity}), transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      {/* Vignette */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${vignette}) 100%)`,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
