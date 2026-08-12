import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { PageCam, CamKey } from '../lib/PageCam';
import { TOKENS, FONT_MONO, EASE_CAM, EASE_POP, EASE_RESET } from '../tokens';
import layout from '../layout.json';

const PAGE_H = layout.dashboard.pageH;
const LAUNCH = layout.dashboard.cutouts.find((c) => c.file === 'dash-launch.png')!;
const LX = LAUNCH.x;
const LY = LAUNCH.y;
const LW = LAUNCH.w;
const LH = LAUNCH.h;
const LCX = LX + LW / 2;
const LCY = LY + LH / 2;

const KICKER = 'MINECRAFT LAUNCHER';

const CAM_KEYS: CamKey[] = [
  { frame: 82, cx: 960, cy: 540, zoom: 0.78, rotX: 0, rotY: 0, rotZ: 0, persp: 1200 },
  { frame: 114, cx: 960, cy: 540, zoom: 0.78, rotX: 0, rotY: 0, rotZ: 0, persp: 1200 },
  { frame: 130, cx: LCX - 20, cy: LCY, zoom: 2.5, rotX: 6, rotY: 20, rotZ: 1.5, persp: 1200 },
  { frame: 220, cx: LCX - 20, cy: LCY, zoom: 2.48, rotX: 6, rotY: 20, rotZ: 1.5, persp: 1200 },
];

/** SceneOpen — brand open (0–83): a green crosshair draws in, "QOMICEX"
 * letterpresses in glyph by glyph, a mono kicker types itself out, the lockup
 * rests fully on ~1s (46–76) then dissolves and hands to the dashboard.
 *
 * Single launch-bar macro (82–220): a green spotlight roves the dashboard,
 * locks onto the launch bar, the camera pushes in and swings to a left-side
 * view, the bar springs up and hovers while a beam runs two laps around its
 * outline, then it settles flush back into its slot. */
export const SceneOpen: React.FC = () => {
  const frame = useCurrentFrame();

  // --- kicker typewriter (28 -> ~44), 0.7 frames per char ---
  const perChar = 0.7;
  const kickStart = 28;
  const kickChars = Math.floor(Math.max(0, frame - kickStart) / perChar);
  const kickDone = kickStart + KICKER.length * perChar;
  const cursorOn = (() => {
    if (frame < kickStart) return false;
    if (frame < kickDone) return true;
    if (frame > 74) return false;
    const b = frame - kickDone;
    return Math.floor(b / 2) % 2 === 0;
  })();

  const brandOut = interpolate(frame, [76, 83], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.4, 0, 0.5, 1),
  });
  const brandOpacity = 1 - brandOut;
  const groupY = -brandOut * 40;
  const groupScale = 1 - brandOut * 0.12;

  const macroIn = interpolate(frame, [82, 90], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.3, 0, 0.2, 1),
  });

  // --- roving spotlight ---
  const spotEase = Easing.bezier(0.4, 0, 0.3, 1);
  const spotX = interpolate(frame, [86, 90, 98, 104, 110, 130], [25, 25, 70, 42, 50, 50], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: spotEase,
  });
  // during the roam the camera is full-page (bar sits ~52%/83% on screen);
  // when it pushes in (130) the bar is centered, so the spotlight converges
  // back to the screen center instead of drifting below the bar.
  const spotY = interpolate(frame, [86, 90, 98, 104, 110, 130], [30, 30, 45, 60, 83, 50], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: spotEase,
  });
  const spotOn = interpolate(frame, [84, 92], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const poolBase = interpolate(frame, [104, 114, 130], [620, 420, 380], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.4, 0, 0.3, 1),
  });
  const poolPulse = interpolate(frame, [114, 118, 123], [0, 0.06, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const poolRx = poolBase * (1 + poolPulse);
  const poolRy = poolBase * 0.55 * (1 + poolPulse);
  const vignette = interpolate(frame, [104, 114, 130], [0.16, 0.34, 0.42], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  const dofStrength = interpolate(frame, [114, 130, 140, 150], [0, 9, 9, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // --- hero bar pop-up ---
  const rise = interpolate(frame, [130, 140], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(EASE_POP[0], EASE_POP[1], EASE_POP[2], EASE_POP[3]),
  });
  const reseat = interpolate(frame, [194, 212], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(EASE_RESET[0], EASE_RESET[1], EASE_RESET[2], EASE_RESET[3]),
  });
  const lift = rise * (1 - reseat);
  const bob = Math.sin(((frame - 140) / 40) * Math.PI * 2) * 4 * lift;
  const z = 110 * lift + bob;
  const landed = frame >= 212;
  const press = interpolate(frame, [208, 211, 212], [1, 0.997, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const shadow = `0 ${8 * lift}px ${10 + 12 * lift}px rgba(0,0,0,${0.4 * lift}), 0 ${46 * lift}px ${90 * lift}px rgba(0,0,0,${0.5 * lift})`;

  const slotVis = Math.min(1, rise * 2) * (1 - reseat);
  const landPulse = interpolate(frame, [208, 212, 216], [0, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const slotEdge = Math.min(1, 0.4 * (1 - reseat)) + landPulse * 0.6;

  // --- perimeter beam: two laps ---
  const beam1Prog = interpolate(frame, [142, 156], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.linear,
  });
  const beam1On = frame >= 141 && frame <= 157;
  const beam2Prog = interpolate(frame, [162, 182], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.4, 0, 0.4, 1),
  });
  const beam2On = frame >= 161 && frame <= 183;
  const beamTrail = interpolate(frame, [182, 194], [0.35, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const bw = LW + 6;
  const bh = LH + 6;

  const outT = interpolate(frame, [220 - 5, 220], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.5, 0, 0.6, 1),
  });
  const rootOpacity = 1 - outT;

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg, opacity: rootOpacity }}>
      {frame >= 84 ? (
        <AbsoluteFill style={{ opacity: macroIn }}>
          <PageCam
            src="textures/live/dashboard-full.png"
            pageH={PAGE_H}
            keys={CAM_KEYS}
            bg={TOKENS.bg}
            ease={Easing.bezier(EASE_CAM[0], EASE_CAM[1], EASE_CAM[2], EASE_CAM[3])}
            dof={{ focusY: 240, strength: dofStrength }}
          >
            <div
              style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, height: 8,
                background: 'rgba(255,255,255,0.2)', filter: 'blur(6px)',
                opacity: 0.5 * Math.min(1, lift + Math.max(0, (frame - 114) / 16)),
                pointerEvents: 'none',
              }}
            />
            <div style={{ transformStyle: 'preserve-3d' }}>
              {slotVis > 0.02 ? (
                <div
                  style={{
                    position: 'absolute', left: LX - 2, top: LY - 2,
                    width: LW + 4, height: LH + 4, background: TOKENS.card,
                    borderRadius: TOKENS.radius2xl,
                    boxShadow: `inset 0 0 26px rgba(76,208,143,${0.12 * slotEdge})`,
                    opacity: slotVis,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute', inset: 0, borderRadius: TOKENS.radius2xl,
                      border: `1.5px solid ${TOKENS.primary}`, opacity: slotEdge,
                      pointerEvents: 'none',
                    }}
                  />
                </div>
              ) : null}
              <div
                style={{
                  position: 'absolute', left: LX, top: LY,
                  width: LW, height: LH,
                  transform: `translateZ(${z}px) scale(${press})`,
                  transformOrigin: 'center center',
                  transformStyle: 'preserve-3d',
                }}
              >
                <div
                  style={{
                    position: 'absolute', inset: 0, borderRadius: TOKENS.radius2xl,
                    overflow: 'hidden',
                    boxShadow: landed ? 'none' : shadow,
                  }}
                >
                  <Img
                    src={staticFile('textures/live/dash-launch.png')}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                  />
                  <div
                    style={{
                      position: 'absolute', inset: 0,
                      background: 'linear-gradient(160deg, rgba(255,255,255,0.12), transparent 40%)',
                      opacity: lift, pointerEvents: 'none',
                    }}
                  />
                </div>
                <div
                  style={{
                    position: 'absolute', inset: 0, borderRadius: TOKENS.radius2xl,
                    boxShadow: `inset 0 0 0 1px rgba(255,255,255,${0.2 * lift})`,
                    pointerEvents: 'none',
                  }}
                />
                {(beam1On || beam2On) && lift > 0.4 ? (
                  <svg
                    width={bw}
                    height={bh}
                    viewBox={`0 0 ${bw} ${bh}`}
                    style={{
                      position: 'absolute', left: -3, top: -3, overflow: 'visible',
                      pointerEvents: 'none',
                      opacity: beam1On ? 1 : 0.62,
                      filter: `drop-shadow(0 0 6px ${TOKENS.primary}) drop-shadow(0 0 18px ${TOKENS.primaryGlow})`,
                    }}
                  >
                    <rect
                      x={2} y={2} width={bw - 4} height={bh - 4} rx={TOKENS.radius2xl} fill="none"
                      stroke={TOKENS.primary} strokeWidth={beam1On ? 5 : 3.5} strokeLinecap="round"
                      pathLength={1} strokeDasharray="0.14 1" strokeDashoffset={-(beam1On ? beam1Prog : beam2Prog)}
                    />
                    <rect
                      x={2} y={2} width={bw - 4} height={bh - 4} rx={TOKENS.radius2xl} fill="none"
                      stroke="rgba(220,255,235,0.98)" strokeWidth={beam1On ? 2.5 : 1.75} strokeLinecap="round"
                      pathLength={1} strokeDasharray="0.14 1" strokeDashoffset={-(beam1On ? beam1Prog : beam2Prog)}
                    />
                  </svg>
                ) : null}
                {beamTrail > 0.01 ? (
                  <div
                    style={{
                      position: 'absolute', inset: -3, borderRadius: TOKENS.radius2xl + 3,
                      border: `1.5px solid ${TOKENS.primary}`, opacity: beamTrail,
                      pointerEvents: 'none',
                    }}
                  />
                ) : null}
              </div>
            </div>
          </PageCam>

          {/* roving / locking spotlight */}
          <AbsoluteFill
            style={{
              background: `radial-gradient(${poolRx}px ${poolRy}px at ${spotX}% ${spotY}%, rgba(76,208,143,0.30), rgba(76,208,143,0.08) 45%, rgba(2,6,4,${vignette * spotOn}) 100%)`,
              pointerEvents: 'none',
              opacity: spotOn,
            }}
          />
          <AbsoluteFill
            style={{
              background: `radial-gradient(300px 220px at ${spotX - 6}% ${spotY + 8}%, rgba(76,208,143,0.14), transparent 70%)`,
              pointerEvents: 'none',
              opacity: spotOn * 0.7,
            }}
          />
        </AbsoluteFill>
      ) : null}

      {/* brand group — logo image + kicker typewriter */}
      {brandOpacity > 0 ? (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none', opacity: brandOpacity }}>
          <div
            style={{
              textAlign: 'center',
              transform: `translateY(${groupY}px) scale(${groupScale})`,
              transformOrigin: 'center center',
            }}
          >
            {(() => {
              const logoIn = interpolate(frame, [8, 18], [0, 1], {
                extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
                easing: Easing.bezier(0.3, 0, 0.2, 1),
              });
              const logoClear = interpolate(frame, [10, 20], [8, 0], {
                extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
              });
              const glintProg = interpolate(frame, [26, 42], [0, 1], {
                extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
                easing: Easing.bezier(0.4, 0, 0.3, 1),
              });
              return (
                <div
                  style={{
                    position: 'relative',
                    display: 'inline-block',
                    opacity: logoIn,
                    transform: `scale(${1.8 - 0.8 * logoIn})`,
                    transformOrigin: 'center center',
                    filter: `blur(${logoClear}px) drop-shadow(0 0 30px ${TOKENS.primaryDim})`,
                  }}
                >
                  <Img
                    src={staticFile('textures/logo.png')}
                    style={{ display: 'block', width: 220, height: 268, objectFit: 'contain', margin: '0 auto' }}
                  />
                  {glintProg > 0 && glintProg < 1 ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: `${glintProg * 140 - 40}%`,
                        top: 0,
                        width: '40%',
                        height: '100%',
                        background: `linear-gradient(105deg, transparent 0%, rgba(255,255,255,0.35) 45%, rgba(255,255,255,0.5) 50%, rgba(255,255,255,0.35) 55%, transparent 100%)`,
                        pointerEvents: 'none',
                      }}
                    />
                  ) : null}
                </div>
              );
            })()}

            <div
              style={{
                fontFamily: FONT_MONO, fontSize: 22, letterSpacing: '0.4em', color: TOKENS.muted,
                marginTop: 30, textTransform: 'uppercase', height: 30,
                display: 'flex', justifyContent: 'center', alignItems: 'center',
              }}
            >
              <span style={{ whiteSpace: 'pre' }}>{KICKER.slice(0, kickChars)}</span>
              <span
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 22,
                  marginLeft: 4,
                  background: TOKENS.primary,
                  opacity: cursorOn ? 0.85 : 0,
                }}
              />
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
