import { Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { PageCam, CamKey } from '../lib/PageCam';
import { TOKENS, EASE_FLY, EASE_SETTLE } from '../tokens';
import layout from '../layout.json';

const inst = layout.instances;
const PAGE_H = inst.pageH;

const cards = inst.cutouts
  .filter((c) => c.file.startsWith('inst-card'))
  .map((c) => ({ file: c.file, x: c.x, y: c.y, w: c.w, h: c.h }));

const COLS = [96, 397.328125, 698.65625, 1000, 1301.328125, 1602.65625];
const CARD_W = 285.328125;
const EXTRA_ROWS = [523.5, 789, 1054.5];
const PAPER_EXT = { x: 0, y: PAGE_H, w: 1920, h: 1400 };

const extras = Array.from({ length: 12 }, (_, i) => ({
  file: `inst-card${((i * 3 + 1) % 6) + 1}.png`,
  x: COLS[i % 6],
  y: EXTRA_ROWS[Math.floor(i / 6)],
  w: CARD_W,
  h: 187.5,
}));

// the DECK: 6 real cards + 12 extras stacked top-right
const PILE = { x: 1480, y: 220 };
const N_CARDS = 18;
const DEAL_START = 36;
const STACK_STEP = 3;

const grid = [
  ...cards.map((c) => ({ ...c, title: '' })),
  ...extras.map((c, i) => ({ ...c, title: `extra-${i}` })),
]
  .sort((a, b) => a.y - b.y || a.x - b.x)
  .map((c, k) => ({
    ...c,
    cue: DEAL_START + 4 * k - 0.0792 * k * (k - 1),
    px: PILE.x + (((k * 7) % 9) - 4) * 2,
    py: PILE.y + (((k * 5) % 7) - 3) * 2,
    protZ: ((k * 11) % 7) - 3,
    pz: (N_CARDS - k) * STACK_STEP,
  }));

const PILE_CX = PILE.x + CARD_W / 2;
const PILE_CY = PILE.y + 94;

const CAM_KEYS: CamKey[] = [
  { frame: 0, cx: PILE_CX - 30, cy: PILE_CY + 60, zoom: 2.2, rotX: 46, rotY: -30, rotZ: 9, persp: 1100 },
  { frame: 34, cx: PILE_CX + 30, cy: PILE_CY + 40, zoom: 2.1, rotX: 42, rotY: 26, rotZ: -7, persp: 1100 },
  { frame: 62, cx: 960, cy: 420, zoom: 0.95, rotX: 24, rotY: 0, rotZ: 2, persp: 1300 },
  { frame: 82, cx: 950, cy: 700, zoom: 0.82, rotX: 12, rotY: 0, rotZ: 0, persp: 1300 },
  { frame: 98, cx: 960, cy: 1080, zoom: 0.7, rotX: 0, rotY: 0, rotZ: 0, persp: 1300 },
  { frame: 113, cx: 960, cy: 1080, zoom: 0.7, rotX: 0, rotY: 0, rotZ: 0, persp: 1300 },
  { frame: 124, cx: 960, cy: 380, zoom: 0.9, rotX: 0, rotY: 0, rotZ: 0, persp: 1300 },
  { frame: 174, cx: 960, cy: 380, zoom: 0.9, rotX: 0, rotY: 0, rotZ: 0, persp: 1300 },
  { frame: 190, cx: 960, cy: 380, zoom: 0.9, rotX: 0, rotY: 0, rotZ: 0, persp: 1300 },
];

export const SceneDeal: React.FC = () => {
  const frame = useCurrentFrame();

  const dofStrength = interpolate(frame, [82, 98], [5, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <PageCam
      src="textures/live/instances-full.png"
      pageH={PAGE_H}
      keys={CAM_KEYS}
      bg={TOKENS.bg}
      ease={Easing.bezier(0.33, 0, 0.15, 1)}
      dof={dofStrength > 0.1 ? { focusY: 260, strength: dofStrength } : undefined}
    >
      {/* dark brushed-metal table under the opening pile close-up */}
      {frame < 56 ? (
        <div
          style={{
            position: 'absolute',
            left: PILE.x - 1000,
            top: PILE.y - 1000,
            width: 2200,
            height: 2200,
            opacity: interpolate(frame, [34, 56], [1, 0], {
              extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
            }),
            background: [
              `radial-gradient(1300px 900px at ${1000 + PILE_CX - PILE.x}px ${1000 + PILE_CY - PILE.y}px, rgba(76,208,143,0.14), rgba(76,180,130,0.05) 40%, transparent 68%)`,
              'repeating-linear-gradient(100deg, rgba(255,255,255,0.028) 0px, rgba(255,255,255,0.028) 1px, transparent 2px, transparent 7px)',
              'repeating-linear-gradient(100deg, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 2px, transparent 4px, transparent 13px)',
              'linear-gradient(115deg, #151a20 0%, #1c222b 28%, #12151b 55%, #1b212a 78%, #10141a 100%)',
            ].join(', '),
            pointerEvents: 'none',
          }}
        />
      ) : null}

      {/* page extension below the texture for extra rows */}
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

      {/* ---- the cards ---- */}
      {grid.map((c, i) => {
        const { cue } = c;
        const radius = TOKENS.radius2xl;

        const diveT = interpolate(frame, [cue, cue + 8], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(EASE_FLY[0], EASE_FLY[1], EASE_FLY[2], EASE_FLY[3]),
        });
        const settleT = interpolate(frame, [cue + 8, cue + 12], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(EASE_SETTLE[0], EASE_SETTLE[1], EASE_SETTLE[2], EASE_SETTLE[3]),
        });

        const dx = (c.px - c.x) * (1 - diveT);
        const dy = (c.py - c.y) * (1 - diveT);
        const rotFlight = c.protZ * (1 - diveT);

        const arc = Math.sin(diveT * Math.PI) * 90;
        const zDive = interpolate(diveT, [0, 1], [c.pz, 40]) + arc;
        const z = frame < cue ? c.pz : zDive * (1 - settleT);

        const dealScale = 1 + Math.sin(diveT * Math.PI) * 0.06;
        const press = interpolate(frame, [cue + 10, cue + 11, cue + 12], [1, 0.996, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });
        const scale = dealScale * press;

        const landed = frame >= cue + 12;
        const inPile = frame < cue;
        const transform = landed
          ? 'translate3d(0px, 0px, 0px)'
          : inPile
            ? `translate3d(${c.px - c.x}px, ${c.py - c.y}px, ${c.pz}px) rotateZ(${c.protZ}deg)`
            : `translate3d(${dx}px, ${dy}px, ${z}px) rotateZ(${rotFlight}deg) scale(${scale})`;

        const shadow = landed
          ? '0 2px 6px rgba(0,0,0,.5)'
          : inPile
            ? '0 1px 3px rgba(0,0,0,.6)'
            : `0 ${36 - 30 * settleT}px ${70 - 60 * settleT}px rgba(0,0,0,${0.5 - 0.3 * settleT})`;

        const showGhost = diveT > 0.02 && diveT < 0.98;
        const ghostLagX = (c.px - c.x) * 0.05;
        const ghostLagY = (c.py - c.y) * 0.05;

        return (
          <div key={`${c.file}-${i}`} style={{ transformStyle: 'preserve-3d' }}>
            {showGhost ? (
              <div
                style={{
                  position: 'absolute',
                  left: c.x,
                  top: c.y,
                  width: c.w,
                  height: c.h,
                  transform: `translate3d(${dx + ghostLagX}px, ${dy + ghostLagY}px, ${z}px) rotateZ(${rotFlight}deg) scale(${scale})`,
                  transformOrigin: 'center center',
                  opacity: 0.25 * (1 - diveT),
                  filter: 'blur(6px)',
                  borderRadius: radius,
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                <Img
                  src={staticFile(`textures/live/${c.file}`)}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                />
              </div>
            ) : null}

            <div
              style={{
                position: 'absolute',
                left: c.x,
                top: c.y,
                width: c.w,
                height: c.h,
                transform,
                transformOrigin: 'center center',
                boxShadow: shadow,
                borderRadius: radius,
                overflow: 'hidden',
              }}
            >
              <Img
                src={staticFile(`textures/live/${c.file}`)}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
              />
            </div>
          </div>
        );
      })}

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: PAPER_EXT.y + PAPER_EXT.h - 8,
          height: 8,
          background: 'rgba(255,255,255,0.2)',
          filter: 'blur(6px)',
          opacity: 0.4,
          pointerEvents: 'none',
        }}
      />
    </PageCam>
  );
};
