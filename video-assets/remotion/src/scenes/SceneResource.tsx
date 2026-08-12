import { Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { PageCam, CamKey } from '../lib/PageCam';
import { TOKENS, EASE_CAM } from '../tokens';

const PAGE_H = 1080;
const QUERY = 'sodium';
const TYPE_START = 24;
const CHAR_FRAMES = 3;
const FILTER_START = TYPE_START + QUERY.length * CHAR_FRAMES + 6;
const SEARCH = { x: 113, y: 221, w: 1444, h: 40 };

// real captured frames: rc-type-0 (initial) .. rc-type-6 (sodium typed), rc-filtered
const TYPE_FRAMES = Array.from({ length: QUERY.length + 1 }, (_, i) => `rc-type-${i}.png`);

// Sodium card position in the filtered result (from capture)
const SODIUM_CARD = { x: 96, y: 374.5, w: 1792, h: 160 };

const CAM_KEYS: CamKey[] = [
  { frame: 0, cx: 960, cy: 560, zoom: 0.95, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 20, cx: 960, cy: 380, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 65, cx: 960, cy: 380, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 80, cx: 960, cy: 500, zoom: 1.15, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 100, cx: SODIUM_CARD.x + SODIUM_CARD.w / 2, cy: SODIUM_CARD.y + SODIUM_CARD.h / 2, zoom: 2.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
  { frame: 125, cx: SODIUM_CARD.x + SODIUM_CARD.w / 2, cy: SODIUM_CARD.y + SODIUM_CARD.h / 2, zoom: 2.0, rotX: 0, rotY: 0, rotZ: 0, persp: 1400 },
];

/**
 * SceneResource — real UI interaction: "sodium" is typed into the search box
 * via real captured frames (3f/char), then Enter fires a real Modrinth search
 * and the filtered result replaces the page. Camera pushes into the Sodium card.
 */
export const SceneResource: React.FC = () => {
  const frame = useCurrentFrame();

  // which base image to show
  const getBaseSrc = (): string => {
    if (frame < FILTER_START) {
      if (frame < TYPE_START) return `textures/live/${TYPE_FRAMES[0]}`;
      const idx = Math.min(QUERY.length, Math.floor((frame - TYPE_START) / CHAR_FRAMES) + 1);
      return `textures/live/${TYPE_FRAMES[idx]}`;
    }
    return 'textures/live/rc-filtered.png';
  };

  // search box focus ring (real green border from captured input)
  const focusOpacity = interpolate(frame, [6, 12, FILTER_START, FILTER_START + 4], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // green focus ring around search area
  const ringPulse = frame >= 8 && frame <= FILTER_START + 4
    ? 0.6 + 0.4 * Math.sin(frame * 0.3)
    : 0;

  // click ripple on the sodium card in filtered view
  const clickStart = FILTER_START + 12;
  const showClick = frame >= clickStart && frame <= clickStart + 14;

  // focus highlight on sodium card
  const highlightOpacity = frame >= FILTER_START + 8
    ? interpolate(frame, [FILTER_START + 8, FILTER_START + 12], [0, 1], {
        extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
      })
    : 0;

  return (
    <PageCam
      src={getBaseSrc()}
      pageH={PAGE_H}
      keys={CAM_KEYS}
      bg={TOKENS.bg}
      ease={Easing.bezier(EASE_CAM[0], EASE_CAM[1], EASE_CAM[2], EASE_CAM[3])}
    >
      {/* green focus ring around the search box */}
      {focusOpacity > 0.05 ? (
        <div
          style={{
            position: 'absolute',
            left: SEARCH.x - 2,
            top: SEARCH.y - 2,
            width: SEARCH.w + 4,
            height: SEARCH.h + 4,
            borderRadius: 12,
            border: `2px solid ${TOKENS.primary}`,
            boxShadow: `0 0 ${12 + 8 * ringPulse}px ${TOKENS.primaryGlow}`,
            opacity: focusOpacity * ringPulse,
            pointerEvents: 'none',
          }}
        />
      ) : null}

      {/* click ripple on the sodium card */}
      {showClick ? (() => {
        const t = interpolate(frame, [clickStart, clickStart + 14], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
        });
        const cx = SODIUM_CARD.x + SODIUM_CARD.w / 2;
        const cy = SODIUM_CARD.y + SODIUM_CARD.h / 2;
        const rad = interpolate(t, [0, 1], [16, 80]);
        return (
          <div
            style={{
              position: 'absolute',
              left: cx - rad,
              top: cy - rad,
              width: rad * 2,
              height: rad * 2,
              borderRadius: '50%',
              border: `2px solid ${TOKENS.primary}`,
              opacity: 1 - t,
              pointerEvents: 'none',
            }}
          />
        );
      })() : null}

      {/* sodium card focus highlight */}
      {highlightOpacity > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: SODIUM_CARD.x - 4,
            top: SODIUM_CARD.y - 4,
            width: SODIUM_CARD.w + 8,
            height: SODIUM_CARD.h + 8,
            borderRadius: 16,
            border: `2px solid ${TOKENS.primary}`,
            boxShadow: `0 0 30px ${TOKENS.primaryGlow}`,
            opacity: highlightOpacity * 0.7,
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </PageCam>
  );
};
