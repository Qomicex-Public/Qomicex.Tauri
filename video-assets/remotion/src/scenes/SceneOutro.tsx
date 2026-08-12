import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { PageCam, CamKey } from '../lib/PageCam';
import { TOKENS, FONT_MONO } from '../tokens';
import layout from '../layout.json';

const PAGE_H = layout.dashboard.pageH;

const FLY_EASE = Easing.bezier(0.34, 1.4, 0.44, 1);
const CRANE_EASE = Easing.bezier(0.3, 0, 0.2, 1);

type FlyEl = {
  key: string;
  file: string;
  w: number;
  h: number;
  cx: number;
  cy: number;
  scale: number;
  rot: number;
  dx: number;
  dy: number;
  radius: number;
  cue: number;
};

// representative elements from every shown feature
const ELS: FlyEl[] = [
  { key: 'brand', file: 'dash-brand.png', w: 291, h: 60, cx: 960, cy: 250, scale: 0.85, rot: 0, dx: 0, dy: -260, radius: 8, cue: 4 },
  { key: 'inst1', file: 'inst-card1.png', w: 285, h: 188, cx: 320, cy: 470, scale: 0.7, rot: -5, dx: -520, dy: 0, radius: 16, cue: 7 },
  { key: 'inst2', file: 'inst-card4.png', w: 285, h: 188, cx: 1620, cy: 460, scale: 0.68, rot: 4, dx: 520, dy: 0, radius: 16, cue: 10 },
  { key: 'dl-task', file: 'dl-task4.png', w: 1792, h: 113, cx: 960, cy: 720, scale: 0.42, rot: -2, dx: 0, dy: 300, radius: 12, cue: 13 },
  { key: 'rc1', file: 'rc-card1.png', w: 1792, h: 160, cx: 600, cy: 880, scale: 0.36, rot: 2, dx: -480, dy: 260, radius: 12, cue: 16 },
  { key: 'rc2', file: 'rc-card3.png', w: 1792, h: 160, cx: 1330, cy: 880, scale: 0.36, rot: -3, dx: 480, dy: 260, radius: 12, cue: 19 },
  { key: 'acc', file: 'acc-card1.png', w: 1792, h: 66, cx: 960, cy: 560, scale: 0.4, rot: -1.5, dx: 0, dy: 320, radius: 10, cue: 22 },
  { key: 'set', file: 'set-panel1.png', w: 1584, h: 1250, cx: 960, cy: 950, scale: 0.24, rot: 1.5, dx: 0, dy: 380, radius: 12, cue: 25 },
  { key: 'conn', file: 'conn-card1.png', w: 1750, h: 36, cx: 700, cy: 180, scale: 0.5, rot: -3, dx: -620, dy: -120, radius: 8, cue: 28 },
];

// 20 green-gold dust motes, all deterministic
const DUST = Array.from({ length: 20 }, (_, i) => ({
  x: (i * 439 + 137) % 1920,
  y0: (i * 613 + 271) % 1080,
  rise: 0.3 + (i % 5) * 0.11,
  swayAmp: 9 + (i % 4) * 5,
  swayFreq: 0.022 + (i % 3) * 0.008,
  phase: (i * 0.83) % (Math.PI * 2),
  size: 2 + (i % 3) * 0.5,
  opacity: 0.15 + ((i * 7) % 5) * 0.05,
}));

/** SceneOutro — "group photo" finale: representative elements from every page
 * fly in from off-screen and settle in an arc around the center; the
 * letterpressed QOMICEX wordmark takes the stage while the elements recede,
 * under a crane-in camera, stage light, dust and an opening light sweep.
 * Sign-off hold ~1s. */
export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 145;

  const blur = interpolate(frame, [0, 24], [0, 14], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.4, 0, 0.4, 1),
  });
  const rule = interpolate(frame, [58, 70], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.3, 0, 0.2, 1),
  });
  const tag = interpolate(frame, [68, 80], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(frame, [duration - 12, duration], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const recede = interpolate(frame, [42, 50], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  const craneT = interpolate(frame, [0, 40], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: CRANE_EASE,
  });
  const pushT = interpolate(frame, [40, duration], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const camScale = 1.06 - 0.06 * craneT + 0.035 * pushT;
  const camTilt = 4 * (1 - craneT);

  const sweepX = interpolate(frame, [2, 14], [-700, 2020], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.4, 0, 0.6, 1),
  });
  const sweepOpacity = interpolate(frame, [2, 5, 11, 14], [0, 0.12, 0.12, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  const stageLight = interpolate(frame, [42, 50, 58], [0, 0.5, 0.25], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const vignette = interpolate(frame, [42, 54], [0, 0.1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const ruleExt = interpolate(frame, [58, 66], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.3, 0, 0.2, 1),
  });
  const ruleExtFade = interpolate(frame, [66, 72], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.3, 0, 0.2, 1),
  });

  const CAM: CamKey[] = [{ frame: 0, cx: 960, cy: 700, zoom: 0.75 }];

  return (
    <AbsoluteFill style={{ opacity: fadeOut, backgroundColor: TOKENS.bg }}>
      <AbsoluteFill
        style={{
          transform: `perspective(1400px) rotateX(${camTilt}deg) scale(${camScale})`,
          transformOrigin: '50% 45%',
        }}
      >
        <PageCam src="textures/live/dashboard-full.png" pageH={PAGE_H} keys={CAM} bg={TOKENS.bg} blur={blur} saturate={0.85} />
        {/* green scrim keeps the center legible */}
        <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 48%, hsla(228 20% 6% / 0.82), hsla(228 20% 6% / 0.55) 60%, hsla(228 20% 6% / 0.35))', pointerEvents: 'none' }} />

        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          {ELS.map((el) => {
            if (frame < el.cue) return null;
            const t = interpolate(frame, [el.cue, el.cue + 12], [0, 1], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: FLY_EASE,
            });
            const opacity = interpolate(frame, [el.cue, el.cue + 3], [0, 1], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
            });
            const x = el.dx * (1 - t);
            const y = el.dy * (1 - t);
            const rot = el.rot * (2 - t);
            const scale = el.scale * (1.12 - 0.12 * t);
            const air = Math.max(0, 1 - t);
            const shadow =
              air > 0.01
                ? `0 ${10 + 26 * air}px ${24 + 46 * air}px rgba(0,0,0,${0.35 + 0.15 * air}), 0 2px 6px rgba(0,0,0,.3)`
                : '0 10px 24px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.3)';
            const settledOpacity = opacity * (1 - 0.12 * recede);
            const saturate = 1 - 0.08 * recede;

            const linT = interpolate(frame, [el.cue, el.cue + 12], [0, 1], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
            });
            const showGhost = linT > 0.05 && linT < 0.95;
            const glow = interpolate(frame, [el.cue + 12, el.cue + 18], [0.35, 0], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
            });
            const showGlow = frame >= el.cue + 12 && frame < el.cue + 18;
            const glowR = el.w * el.scale * 0.5;

            return (
              <div key={el.key}>
                {showGhost ? (
                  <div
                    style={{
                      position: 'absolute',
                      left: el.cx - el.w / 2,
                      top: el.cy - el.h / 2,
                      width: el.w,
                      height: el.h,
                      transform: `translate(${x + el.dx * 0.08}px, ${y + el.dy * 0.08}px) rotate(${rot}deg) scale(${scale})`,
                      transformOrigin: 'center center',
                      borderRadius: el.radius,
                      overflow: 'hidden',
                      opacity: 0.2 * Math.max(0, 1 - linT),
                      filter: 'blur(8px)',
                    }}
                  >
                    <Img
                      src={staticFile(`textures/live/${el.file}`)}
                      style={{ position: 'absolute', inset: 0, width: el.w, height: el.h, display: 'block' }}
                    />
                  </div>
                ) : null}
                <div
                  style={{
                    position: 'absolute',
                    left: el.cx - el.w / 2,
                    top: el.cy - el.h / 2,
                    width: el.w,
                    height: el.h,
                    transform: `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${scale})`,
                    transformOrigin: 'center center',
                    borderRadius: el.radius,
                    overflow: 'hidden',
                    boxShadow: shadow,
                    opacity: settledOpacity,
                    filter: `saturate(${saturate})`,
                  }}
                >
                  <Img
                    src={staticFile(`textures/live/${el.file}`)}
                    style={{ position: 'absolute', inset: 0, width: el.w, height: el.h, display: 'block' }}
                  />
                </div>
                {showGlow ? (
                  <div
                    style={{
                      position: 'absolute',
                      left: el.cx - glowR,
                      top: el.cy - glowR,
                      width: glowR * 2,
                      height: glowR * 2,
                      borderRadius: '50%',
                      background: `radial-gradient(circle, ${TOKENS.primaryDim}, transparent 70%)`,
                      opacity: glow,
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </AbsoluteFill>
      </AbsoluteFill>

      {/* green-gold dust */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        {DUST.map((d, i) => {
          const y = (((d.y0 - frame * d.rise) % 1080) + 1080) % 1080;
          const x = d.x + Math.sin(frame * d.swayFreq + d.phase) * d.swayAmp;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: d.size,
                height: d.size,
                borderRadius: '50%',
                background: TOKENS.primary,
                opacity: d.opacity,
              }}
            />
          );
        })}
      </AbsoluteFill>

      {sweepOpacity > 0 ? (
        <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'overlay' }}>
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: sweepX - 300,
              width: 600,
              background: 'linear-gradient(90deg, rgba(120,255,180,0), rgba(120,255,180,0.8) 50%, rgba(120,255,180,0))',
              opacity: sweepOpacity,
            }}
          />
        </AbsoluteFill>
      ) : null}

      {stageLight > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: 'none',
            background: `radial-gradient(700px 360px at 960px 470px, rgba(76,208,143,0.30), rgba(76,208,143,0.10) 55%, transparent 75%)`,
            opacity: stageLight,
          }}
        />
      ) : null}

      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: 'none',
            background: 'radial-gradient(1400px 900px at 50% 50%, rgba(2,6,4,0) 55%, rgba(2,6,4,0.7) 100%)',
            opacity: vignette,
          }}
        />
      ) : null}

      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none' }}>
        <div style={{ textAlign: 'center' }}>
          {(() => {
            const logoDelay = 42;
            const logoIn = interpolate(frame, [logoDelay, logoDelay + 10], [0, 1], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
              easing: Easing.bezier(0.3, 0, 0.2, 1),
            });
            const logoBlur = interpolate(frame, [logoDelay, logoDelay + 10], [6, 0], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
            });
            return (
              <div
                style={{
                  opacity: logoIn,
                  transform: `scale(${1.6 - 0.6 * logoIn})`,
                  transformOrigin: 'center center',
                  filter: `blur(${logoBlur}px) drop-shadow(0 0 30px ${TOKENS.primaryDim})`,
                }}
              >
                <Img
                  src={staticFile('textures/logo.png')}
                  style={{ display: 'block', width: 200, height: 244, objectFit: 'contain', margin: '0 auto' }}
                />
              </div>
            );
          })()}
          <div style={{ position: 'relative', height: 6, width: 260, margin: '34px auto 0' }}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 3,
                background: TOKENS.primary,
                boxShadow: `0 0 20px ${TOKENS.primaryGlow}`,
                transform: `scaleX(${rule})`,
              }}
            />
            {ruleExt > 0 && ruleExtFade > 0 ? (
              <>
                <div style={{ position: 'absolute', top: 2.5, height: 1, right: '100%', width: 190 * ruleExt, background: TOKENS.primary, opacity: ruleExtFade }} />
                <div style={{ position: 'absolute', top: 2.5, height: 1, left: '100%', width: 190 * ruleExt, background: TOKENS.primary, opacity: ruleExtFade }} />
              </>
            ) : null}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 25, letterSpacing: '0.4em', color: TOKENS.muted, marginTop: 30, opacity: tag, textTransform: 'uppercase' }}>
            启动 · 你的世界
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
