import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';
import { TOKENS, FONT_SANS, EASE_OUT } from '../tokens';

/**
 * Title card (dark glassmorphism skin): deep field, statement text
 * letterpressed word by word, green italic accent word, green underline
 * growing beneath. Re-skinned from the paper template — same motion grammar
 * (word-by-word letterpress, one accent, underline), product colors.
 */
export const TitleCard: React.FC<{
  duration: number;
  words: { text: string; accent?: boolean }[];
}> = ({ duration, words }) => {
  const frame = useCurrentFrame();
  const fadeOut = interpolate(frame, [duration - 8, duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const underline = interpolate(frame, [16, 34], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.3, 0, 0.2, 1),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: TOKENS.bg,
        justifyContent: 'center',
        alignItems: 'center',
        opacity: fadeOut,
        backgroundImage: 'radial-gradient(1100px 750px at 50% 42%, hsl(228 24% 12% / 0.9), transparent 65%)',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 1500, padding: '0 80px' }}>
        <div
          style={{
            fontFamily: FONT_SANS,
            fontSize: 100,
            fontWeight: 700,
            lineHeight: 1.2,
            color: TOKENS.fg,
            letterSpacing: '0.02em',
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            columnGap: '0.3em',
          }}
        >
          {words.map((w, i) => {
            const delay = 4 + i * 4;
            const t = interpolate(frame, [delay, delay + 9], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(EASE_OUT[0], EASE_OUT[1], EASE_OUT[2], EASE_OUT[3]),
            });
            return (
              <span
                key={i}
                style={{
                  opacity: t,
                  transform: `scale(${1.22 - 0.22 * t})`,
                  filter: `blur(${(1 - t) * 6}px)`,
                  display: 'inline-block',
                  fontStyle: w.accent ? 'italic' : 'normal',
                  color: w.accent ? TOKENS.primary : undefined,
                  textShadow: w.accent ? `0 0 24px ${TOKENS.primaryDim}` : undefined,
                }}
              >
                {w.text}
              </span>
            );
          })}
        </div>
        <div
          style={{
            height: 5,
            width: 240,
            margin: '36px auto 0',
            borderRadius: 3,
            background: TOKENS.primary,
            boxShadow: `0 0 20px ${TOKENS.primaryGlow}`,
            transform: `scaleX(${underline})`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
