import { Composition } from 'remotion';
import { QmlMain, QML_TOTAL } from './Main';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="QomicexPromo"
      component={QmlMain}
      durationInFrames={QML_TOTAL}
      fps={60}
      width={1920}
      height={1080}
    />
  );
};
