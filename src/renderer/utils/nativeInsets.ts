import { Capacitor, registerPlugin } from '@capacitor/core';

interface NativeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const Insets = registerPlugin<{ getInsets: () => Promise<NativeInsets> }>('Insets');

// 底部至少留这么多，和 index.css 里 env() 兜底值的口径保持一致
const MIN_BOTTOM = 10;

/**
 * 用原生读到的系统栏高度覆盖 index.css 里的 --safe-area-inset-*。
 *
 * index.css 里的 env(safe-area-inset-*) 在 Android WebView 里只反映屏幕挖孔，
 * 状态栏和手势条都取不到（恒为 0），必须靠原生侧 {@see InsetsPlugin} 给值，
 * 否则 targetSdk 35 强制 edge-to-edge 之后顶栏会被状态栏压住。
 */
export const applyNativeInsets = async () => {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const insets = await Insets.getInsets();
    const root = document.documentElement;

    // 直接写在 :root 的内联样式上，优先级高于样式表里的 env() 声明
    root.style.setProperty('--safe-area-inset-top', `${insets.top}px`);
    root.style.setProperty('--safe-area-inset-right', `${insets.right}px`);
    root.style.setProperty('--safe-area-inset-bottom', `${Math.max(MIN_BOTTOM, insets.bottom)}px`);
    root.style.setProperty('--safe-area-inset-left', `${insets.left}px`);
  } catch (error) {
    console.warn('[nativeInsets] 读取系统栏高度失败，回退到 env()', error);
  }
};

/**
 * 启动时取一次，并在旋转屏幕 / 系统栏变化后重新取。
 */
export const watchNativeInsets = () => {
  if (!Capacitor.isNativePlatform()) return;

  applyNativeInsets();
  window.addEventListener('resize', applyNativeInsets);
};
