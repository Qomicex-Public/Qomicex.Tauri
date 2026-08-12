import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { TOKENS, FONT_SANS } from '../tokens';

/**
 * SceneFeatures — 功能展示布局（真实截图版）
 * 左列：纵向文字滚屏模糊轮播，与右侧内容完全同步
 * 右面板：每个功能的完整操作流程，真实截图逐帧播放
 */

const FEATURES = [
  { label: '多实例管理', color: TOKENS.primary, duration: 240 },
  { label: '快捷模组安装', color: 'hsl(200 70% 55%)', duration: 540 },
  { label: '多账户管理', color: 'hsl(280 65% 55%)', duration: 480 },
  { label: '个性化主题', color: 'hsl(35 85% 55%)', duration: 180 },
  { label: '多人联机', color: 'hsl(180 65% 50%)', duration: 240 },
];

const TOTAL_FEATURE_FRAMES = FEATURES.reduce((sum, f) => sum + f.duration, 0);

// 截图序列定义
const INSTANCES_SHOTS = [
  { file: 'inst-01-hover.png', start: 0, end: 120 },
  { file: 'inst-02-detail.png', start: 120, end: 240 },
];

const RESOURCE_SHOTS = [
  { file: 'rc-01-search-1.png', start: 0, end: 54 },
  { file: 'rc-02-search-2.png', start: 54, end: 108 },
  { file: 'rc-03-search-3.png', start: 108, end: 162 },
  { file: 'rc-04-search-4.png', start: 162, end: 216 },
  { file: 'rc-05-search-5.png', start: 216, end: 270 },
  { file: 'rc-06-search-6.png', start: 270, end: 324 },
  { file: 'rc-07-install-dialog.png', start: 324, end: 384 },
  { file: 'rc-08-select-version.png', start: 384, end: 444 },
  { file: 'rc-09-version-selected.png', start: 444, end: 504 },
  { file: 'rc-10-install-done.png', start: 504, end: 540 },
];

const ACCOUNTS_SHOTS = [
  { file: 'acc-01-list.png', start: 0, end: 48 },
  { file: 'acc-02-add-dialog.png', start: 48, end: 96 },
  { file: 'acc-03-fetching.png', start: 96, end: 144 },
  { file: 'acc-04-device-code.png', start: 144, end: 192 },
  { file: 'acc-05-ms-login.png', start: 192, end: 240 },
  { file: 'acc-06-auth-page.png', start: 240, end: 288 },
  { file: 'acc-07-return-app.png', start: 288, end: 336 },
  { file: 'acc-08-login-done.png', start: 336, end: 384 },
  { file: 'acc-09-detail.png', start: 384, end: 432 },
  { file: 'acc-10-skin-dialog.png', start: 432, end: 480 },
];

const SETTINGS_SHOTS = [
  { file: 'set-01-appearance.png', start: 0, end: 60 },
  { file: 'set-02-select.png', start: 60, end: 120 },
  { file: 'set-03-light.png', start: 120, end: 180 },
];

const CONNECT_SHOTS = [
  { file: 'conn-00-create.png', start: 0, end: 60 },
  { file: 'conn-01-scan.png', start: 60, end: 120 },
  { file: 'conn-02-scanned.png', start: 120, end: 180 },
  { file: 'conn-03-players.png', start: 180, end: 240 },
];

// 通用截图序列播放器：淡入当前帧，淡出下一帧
const ShotSequence: React.FC<{
  shots: Array<{ file: string; start: number; end: number }>;
  localFrame: number;
  basePath: string;
}> = ({ shots, localFrame, basePath }) => {
  const fadeLen = 8; // 淡入淡出帧数

  return (
    <>
      {shots.map((shot, i) => {
        const isCurrent = localFrame >= shot.start && localFrame < shot.end;
        const isNext = i < shots.length - 1 && localFrame >= shots[i + 1].start - fadeLen && localFrame < shots[i + 1].start;

        if (!isCurrent && !isNext) return null;

        let opacity = 1;
        if (isCurrent && i > 0) {
          // 淡入
          opacity = interpolate(localFrame, [shot.start, shot.start + fadeLen], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
        }
        if (isNext) {
          // 淡出到下一帧
          opacity = interpolate(localFrame, [shots[i + 1].start - fadeLen, shots[i + 1].start], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
        }

        return (
          <div key={shot.file} style={{ position: 'absolute', inset: 0, opacity }}>
            <Img
              src={staticFile(`${basePath}/${shot.file}`)}
              style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0a0a0a' }}
            />
          </div>
        );
      })}
    </>
  );
};

export const SceneFeatures: React.FC = () => {
  const frame = useCurrentFrame();

  // 计算当前功能索引和本地帧
  let accumulatedFrames = 0;
  let currentIndex = 0;
  let localFrame = frame;

  for (let i = 0; i < FEATURES.length; i++) {
    if (frame < accumulatedFrames + FEATURES[i].duration) {
      currentIndex = i;
      localFrame = frame - accumulatedFrames;
      break;
    }
    accumulatedFrames += FEATURES[i].duration;
    if (i === FEATURES.length - 1) {
      currentIndex = FEATURES.length - 1;
      localFrame = frame - accumulatedFrames + FEATURES[i].duration;
    }
  }

  const currentFeature = FEATURES[currentIndex];
  const accentColor = currentFeature.color;

  // 左列文字偏移
  const textOffset = -currentIndex * 80;

  // 右面板截图序列
  const renderFeatureAnimation = () => {
    switch (currentIndex) {
      case 0:
        return (
          <ShotSequence
            shots={INSTANCES_SHOTS}
            localFrame={localFrame}
            basePath="textures/live"
          />
        );
      case 1:
        return (
          <ShotSequence
            shots={RESOURCE_SHOTS}
            localFrame={localFrame}
            basePath="textures/live"
          />
        );
      case 2:
        return (
          <ShotSequence
            shots={ACCOUNTS_SHOTS}
            localFrame={localFrame}
            basePath="textures/live"
          />
        );
      case 3:
        return (
          <ShotSequence
            shots={SETTINGS_SHOTS}
            localFrame={localFrame}
            basePath="textures/live"
          />
        );
      case 4:
        return (
          <ShotSequence
            shots={CONNECT_SHOTS}
            localFrame={localFrame}
            basePath="textures/live"
          />
        );
      default:
        return null;
    }
  };

  // 功能指示点
  const dots = FEATURES.map((_, i) => {
    const isActive = i === currentIndex;
    return (
      <div
        key={i}
        style={{
          width: isActive ? 24 : 8,
          height: 8,
          borderRadius: 4,
          background: isActive ? FEATURES[i].color : 'rgba(255,255,255,0.2)',
          transition: 'all 0.3s',
        }}
      />
    );
  });

  return (
    <AbsoluteFill style={{ backgroundColor: TOKENS.bg }}>
      {/* 左列：纵向文字滚屏 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '35%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        {/* 渐变遮罩 */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 200, background: `linear-gradient(to bottom, ${TOKENS.bg}, transparent)`, zIndex: 2, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 200, background: `linear-gradient(to top, ${TOKENS.bg}, transparent)`, zIndex: 2, pointerEvents: 'none' }} />

        {/* 滚动文字 */}
        <div
          style={{
            position: 'absolute',
            left: 60,
            top: '50%',
            transform: `translateY(calc(-50% + ${textOffset}px))`,
            transition: 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {FEATURES.map((feature, i) => {
            const isActive = i === currentIndex;
            const distance = Math.abs(i - currentIndex);
            const opacity = isActive ? 1 : Math.max(0, 1 - distance * 0.4);
            const blur = isActive ? 0 : Math.min(4, distance * 2);
            const scale = isActive ? 1 : Math.max(0.85, 1 - distance * 0.05);

            return (
              <div
                key={i}
                style={{
                  padding: '12px 0',
                  opacity,
                  filter: `blur(${blur}px)`,
                  transform: `scale(${scale})`,
                  transformOrigin: 'left center',
                  transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: 36,
                    fontWeight: 700,
                    color: isActive ? feature.color : TOKENS.fg2,
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  {feature.label}
                  {isActive && (
                    <div
                      style={{
                        width: 4,
                        height: 36,
                        background: feature.color,
                        borderRadius: 2,
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 强调线 */}
        <div
          style={{
            position: 'absolute',
            left: 40,
            top: '50%',
            width: 3,
            height: 80,
            transform: 'translateY(-50%)',
            background: `linear-gradient(to bottom, transparent, ${accentColor}, transparent)`,
            borderRadius: 2,
          }}
        />
      </div>

      {/* 右面板：功能截图演示 */}
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: '65%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: 40, borderRadius: 16, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
          {renderFeatureAnimation()}
          <div style={{ position: 'absolute', inset: 0, borderRadius: 16, border: '1px solid rgba(255,255,255,0.1)', pointerEvents: 'none' }} />
        </div>

        {/* 功能指示点 */}
        <div
          style={{
            position: 'absolute',
            bottom: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 8,
            zIndex: 10,
          }}
        >
          {dots}
        </div>
      </div>

      {/* 垂直分割线 */}
      <div
        style={{
          position: 'absolute',
          left: '35%',
          top: '10%',
          bottom: '10%',
          width: 1,
          background: `linear-gradient(to bottom, transparent, ${TOKENS.border}, transparent)`,
        }}
      />
    </AbsoluteFill>
  );
};
