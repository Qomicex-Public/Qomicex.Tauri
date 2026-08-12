import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { SceneOverheadReveal } from './scenes/SceneOverheadReveal';
import { SceneBrand } from './scenes/SceneBrand';
import { SceneFeatures } from './scenes/SceneFeatures';
import { SceneLogoLockup } from './scenes/SceneLogoLockup';

// 60fps, ~40s = 2400 frames
// Scene breakdown:
// 1. OverheadReveal: 0-120 (2s) - Top-down camera tilt reveal
// 2. Brand: 120-240 (2s) - Letterspace materialize
// 3. Features: 240-1920 (28s) - Split layout with 5 features × 5.6s each
// 4. LogoLockup: 1920-2400 (8s) - Logo shrink and wordmark lockup

export const QML_SHOTS = {
  reveal: { from: 0, duration: 120 },
  brand: { from: 120, duration: 120 },
  features: { from: 240, duration: 1680 },
  lockup: { from: 1920, duration: 480 },
} as const;

export const QML_TOTAL = 2400;

// Sound design (placeholder - can be added later)
const SFX: { from: number; src: string; volume: number }[] = [];

export const QmlMain: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0f14' }}>
      {/* Audio tracks */}
      {SFX.map((s, i) => (
        <Sequence
          key={`sfx-${i}`}
          from={s.from}
          durationInFrames={90}
        >
          <Audio src={staticFile(`audio/${s.src}`)} volume={s.volume} />
        </Sequence>
      ))}

      {/* Scene 1: Overhead Camera Reveal */}
      <Sequence from={QML_SHOTS.reveal.from} durationInFrames={QML_SHOTS.reveal.duration}>
        <SceneOverheadReveal />
      </Sequence>

      {/* Scene 2: Brand Letterspace Materialize */}
      <Sequence from={QML_SHOTS.brand.from} durationInFrames={QML_SHOTS.brand.duration}>
        <SceneBrand />
      </Sequence>

      {/* Scene 3: Features Split Layout */}
      <Sequence from={QML_SHOTS.features.from} durationInFrames={QML_SHOTS.features.duration}>
        <SceneFeatures />
      </Sequence>

      {/* Scene 4: Logo Lockup */}
      <Sequence from={QML_SHOTS.lockup.from} durationInFrames={QML_SHOTS.lockup.duration}>
        <SceneLogoLockup />
      </Sequence>
    </AbsoluteFill>
  );
};
