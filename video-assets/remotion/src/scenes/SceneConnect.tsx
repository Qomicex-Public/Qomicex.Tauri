import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';
import { PageCam, CamKey } from '../lib/PageCam';
import { TOKENS, FONT_MONO } from '../tokens';
import layout from '../layout.json';

const PAGE_H = layout.connect.pageH;

// scanline window travels y: -30 → 420 (screen space), eased 0.06 → 0.66
const T0 = 0.06;
const T1 = 0.66;

type Target = { x: number; y: number; w: number; h: number; label: string };
const targets: Target[] = [
  { x: 96, y: 146, w: 222, h: 40, label: 'CREATE / JOIN ROOM' },
  { x: 1783, y: 79, w: 105, h: 32, label: 'NAT CHECK' },
  { x: 117, y: 299, w: 1750, h: 36, label: 'PICK INSTANCE' },
  { x: 117, y: 351, w: 1750, h: 36, label: 'LAUNCH + HOST' },
];
const tSorted = [...targets].sort((a, b) => a.y - b.y);

// fire times per target (0..1 of scene), min spacing 0.05
const ft = tSorted.map((t) => T0 + ((t.y + t.h + 30) / 450) * (T1 - T0));
for (let i = 1; i < ft.length; i++) {
  ft[i] = Math.max(ft[i], ft[i - 1] + 0.05);
}

const CAM_KEYS: CamKey[] = [
  { frame: 0, cx: 960, cy: 400, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 138, cx: 960, cy: 400, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
];

/** SceneConnect — scanline-annotate-focus over the connect page: a steady
 * scan line travels top to bottom; as it crosses each element, a viewfinder
 * (4 L corners) snaps around it with an overshoot pop and a mono label types
 * in beside it; a status counter top-right counts 0n/04 → ANALYSIS COMPLETE. */
export const SceneConnect: React.FC = () => {
  const frame = useCurrentFrame();
  const F = frame / 138; // normalized scene time

  const scanY = interpolate(F, [T0, T1], [-30, 420], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const scanIn = interpolate(F, [0.04, 0.09], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const scanOut = interpolate(F, [0.66, 0.71], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg }}>
      <PageCam
        src="textures/live/connect-full.png"
        pageH={PAGE_H}
        keys={CAM_KEYS}
        bg={TOKENS.bg}
        ease={Easing.bezier(0.33, 0, 0.15, 1)}
      >
        {/* viewfinder brackets + labels per target */}
        {tSorted.map((t, i) => {
          const tNorm = ft[i];
          if (F < tNorm) return null;
          const pop = interpolate(F, [tNorm, tNorm + 0.13], [1.75, 1], {
            extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.back(2),
          });
          const flash = interpolate(F, [tNorm + 0.04, tNorm + 0.09, tNorm + 0.22], [0, 0.06, 0], {
            extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          });
          const labelIn = interpolate(F, [tNorm + 0.05, tNorm + 0.16], [0, 1], {
            extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
          });
          const arm = 9;
          const labelLeft = t.x + t.w + 16;
          const labelX = labelLeft + 300 < 1920 ? labelLeft : t.x - 16 - 300;

          return (
            <div key={i}>
              {/* focus-confirm fill flash */}
              <div
                style={{
                  position: 'absolute', left: t.x, top: t.y,
                  width: t.w, height: t.h, background: '#fff', opacity: flash,
                  pointerEvents: 'none',
                }}
              />
              {/* viewfinder: 4 L corners over the target, overshoot pop */}
              <svg
                width={t.w}
                height={t.h}
                viewBox={`0 0 ${t.w} ${t.h}`}
                style={{
                  position: 'absolute', left: t.x, top: t.y,
                  transform: `scale(${pop})`,
                  transformOrigin: 'center center',
                  overflow: 'visible', pointerEvents: 'none',
                  filter: `drop-shadow(0 0 6px ${TOKENS.primaryGlow})`,
                }}
              >
                <path d={`M${arm} 0 V${arm} H0`} fill="none" stroke={TOKENS.primary} strokeWidth={1.5} strokeLinecap="round" />
                <path d={`M${t.w - arm} 0 V${arm} H${t.w}`} fill="none" stroke={TOKENS.primary} strokeWidth={1.5} strokeLinecap="round" />
                <path d={`M0 ${t.h - arm} V${t.h} H${arm}`} fill="none" stroke={TOKENS.primary} strokeWidth={1.5} strokeLinecap="round" />
                <path d={`M${t.w} ${t.h - arm} V${t.h} H${t.w - arm}`} fill="none" stroke={TOKENS.primary} strokeWidth={1.5} strokeLinecap="round" />
              </svg>
              {/* mono label */}
              <div
                style={{
                  position: 'absolute', left: labelX, top: t.y + t.h / 2 - 8,
                  fontFamily: FONT_MONO, fontSize: 15, letterSpacing: '0.12em',
                  color: TOKENS.fg, whiteSpace: 'nowrap',
                  opacity: labelIn,
                  transform: `translateY(${(1 - labelIn) * 4}px)`,
                  textShadow: `0 0 12px ${TOKENS.bg}`,
                  pointerEvents: 'none',
                }}
              >
                {t.label}
              </div>
            </div>
          );
        })}

        {/* scan line */}
        {scanIn * scanOut > 0.01 ? (
          <div
            style={{
              position: 'absolute', left: 0, right: 0, top: scanY, height: 2,
              background: `linear-gradient(90deg, transparent, ${TOKENS.primary}, transparent)`,
              boxShadow: `0 0 14px ${TOKENS.primaryGlow}`,
              opacity: scanIn * scanOut,
              pointerEvents: 'none',
            }}
          />
        ) : null}
      </PageCam>

      {/* screen-space status counter */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <div
          style={{
            position: 'absolute', top: 60, right: 90,
            fontFamily: FONT_MONO, fontSize: 16, letterSpacing: '0.14em',
            color: F >= 0.74 ? TOKENS.primary : TOKENS.fg2,
            background: TOKENS.cardBg70,
            border: `1px solid ${TOKENS.border}`,
            borderRadius: 6, padding: '8px 14px', opacity: 0.9,
          }}
        >
          {F >= 0.74 ? (
            <span>SCAN · ANALYSIS COMPLETE</span>
          ) : (
            <span>SCAN · {String(Math.min(4, Math.floor(F / 0.19))).padStart(2, '0')}/04</span>
          )}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
