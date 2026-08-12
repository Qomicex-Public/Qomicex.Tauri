import { Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { PageCam, CamKey } from '../lib/PageCam';
import { TOKENS } from '../tokens';
import layout from '../layout.json';

const PAGE_H = layout.downloads.pageH;
const PAPER_EXT = { x: 0, y: PAGE_H, w: 1920, h: 400 };
const rows = layout.downloads.cutouts
  .filter((c) => c.file.startsWith('dl-task'))
  .map((c) => ({ file: c.file, x: c.x, y: c.y, w: c.w, h: c.h }));

const CAM_KEYS: CamKey[] = [
  { frame: 0, cx: 960, cy: 480, zoom: 1.1, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 75, cx: 960, cy: 760, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
];

/** SceneDownloads — download-center rows embed one by one (row-embed): each
 * task row drops in from above, rotates down flat, and an accent seam flashes
 * at its bottom edge on touchdown. Camera drifts down while the rows land. */
export const SceneDownloads: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <PageCam
      src="textures/live/downloads-full.png"
      pageH={PAGE_H}
      keys={CAM_KEYS}
      bg={TOKENS.bg}
      ease={Easing.bezier(0.33, 0, 0.15, 1)}
    >
      {/* page extension below the texture so the down-pan never exposes the bg */}
      <div
        style={{
          position: 'absolute',
          left: PAPER_EXT.x,
          top: PAPER_EXT.y,
          width: PAPER_EXT.w,
          height: PAPER_EXT.h,
          background: TOKENS.bg,
          pointerEvents: 'none',
        }}
      />

      {/* per-row placeholders (page-color patches) so the baked-in rows don't
          peek through before each overlay row arrives */}
      {rows.map((r, i) => {
        const cue = 12 + i * 9;
        const flight = 12;
        const t = interpolate(frame, [cue, cue + flight], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          easing: Easing.bezier(0.45, 0.05, 0.25, 1.12),
        });
        const landed = frame >= cue + flight;
        const press = interpolate(frame, [cue + flight, cue + flight + 4], [0.995, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });
        // seam: accent slit under the row, centre → sides, then fade
        const seam = interpolate(frame, [cue + flight, cue + flight + 5], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
        });
        const seamFade = interpolate(frame, [cue + flight + 5, cue + flight + 13], [1, 0], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });
        const opacity = interpolate(frame, [cue, cue + 3], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });
        const visible = frame >= cue;

        if (!visible) {
          return (
            <div
              key={r.file}
              style={{
                position: 'absolute',
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                background: TOKENS.bg,
                borderRadius: TOKENS.radius2xl,
                pointerEvents: 'none',
              }}
            />
          );
        }

        return (
          <div key={r.file} style={{ transformStyle: 'preserve-3d' }}>
            <div
              style={{
                position: 'absolute',
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                transform: `perspective(900px) translateY(${-(120 * (1 - t))}px) rotateX(${16 * (1 - t)}deg) scale(${landed ? press : 1.06 - 0.06 * t})`,
                transformOrigin: 'center center',
                opacity,
                borderRadius: TOKENS.radius2xl,
                overflow: 'hidden',
                boxShadow: landed ? '0 2px 10px rgba(0,0,0,0.45)' : '0 24px 48px rgba(0,0,0,0.5)',
              }}
            >
              <Img
                src={staticFile(`textures/live/${r.file}`)}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
              />
            </div>
            {/* accent seam under the row bottom edge */}
            <div
              style={{
                position: 'absolute',
                left: r.x + r.w * 0.1,
                top: r.y + r.h - 2,
                width: r.w * 0.8 * seam,
                height: 2,
                background: TOKENS.primary,
                boxShadow: `0 0 6px ${TOKENS.primaryGlow}`,
                opacity: seamFade,
                transform: 'translateX(' + (1 - seam) * r.w * 0.5 + 'px)',
                pointerEvents: 'none',
              }}
            />
          </div>
        );
      })}

      {/* near-edge rim light along the board bottom */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: PAPER_EXT.y + PAPER_EXT.h - 8,
          height: 8,
          background: 'rgba(255,255,255,0.15)',
          filter: 'blur(6px)',
          opacity: 0.4,
          pointerEvents: 'none',
        }}
      />
    </PageCam>
  );
};
