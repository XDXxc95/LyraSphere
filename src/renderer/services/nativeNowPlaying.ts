import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Android 原生媒体会话桥。
 *
 * WebView 不会为页面里正在播放的 <audio> 生成系统媒体通知（那个通知在 Chrome 里是浏览器自己做的 UI），
 * 音频焦点也拿不到，所以这两件事都交给原生侧的 NowPlayingService 做，
 * 这里只负责把播放状态推过去、把控制指令接回来。
 *
 * 非原生环境（桌面端 / 浏览器）全部 no-op。
 */

export interface NowPlayingMeta {
  title: string;
  artist: string;
  album: string;
  cover: string;
}

export interface NowPlayingPayload extends NowPlayingMeta {
  /** 秒 */
  duration: number;
  /** 秒 */
  position: number;
  isPlaying: boolean;
}

export type NowPlayingAction = 'play' | 'pause' | 'next' | 'prev' | 'stop';

export interface NowPlayingHandlers {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onStop: () => void;
}

interface NowPlayingPlugin {
  start(options: NowPlayingPayload): Promise<void>;
  update(options: NowPlayingPayload): Promise<void>;
  setPlaying(options: { isPlaying: boolean }): Promise<void>;
  stop(): Promise<void>;
  checkPermissions(): Promise<{ notifications: string }>;
  requestPermissions(): Promise<{ notifications: string }>;
  addListener(
    eventName: 'control',
    listener: (data: { action: NowPlayingAction }) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

const plugin = registerPlugin<NowPlayingPlugin>('NowPlaying');

const isNative = Capacitor.isNativePlatform();

/** 位置更新节流间隔：原生 PlaybackState 会自己按 rate 外推，不需要高频同步 */
const POSITION_THROTTLE_MS = 1000;

const state: NowPlayingPayload = {
  title: '',
  artist: '',
  album: '',
  cover: '',
  duration: 0,
  position: 0,
  isPlaying: false
};

/** 原生侧的服务是否已经起来了，决定用 start 还是 update */
let serviceRunning = false;
let lastPositionAt = 0;

/**
 * Android 13+ 弹一次通知授权。
 * 刻意不 await：授权对话框会阻塞好几秒，等它关掉再起服务反而会让通知延迟出现。
 */
const ensureNotificationPermission = () => {
  plugin
    .checkPermissions()
    .then((current) => (current.notifications === 'granted' ? null : plugin.requestPermissions()))
    .then((result) => {
      if (result && result.notifications !== 'granted') {
        console.warn('[nativeNowPlaying] 未授予通知权限，通知栏控件不会显示');
      }
    })
    .catch((error) => console.warn('[nativeNowPlaying] 申请通知权限失败', error));
};

const push = async (isFirst: boolean) => {
  if (isFirst) {
    // 先置位：start 是异步的，同一 tick 里的后续调用不该再走一遍 start
    serviceRunning = true;
    ensureNotificationPermission();
    await plugin.start({ ...state });
  } else {
    await plugin.update({ ...state });
  }
};

/** 换歌：元数据整包推过去 */
export const updateNowPlayingMetadata = (meta: NowPlayingMeta) => {
  if (!isNative) return;

  state.title = meta.title;
  state.artist = meta.artist;
  state.album = meta.album;
  state.cover = meta.cover;
  state.position = 0;

  const isFirst = !serviceRunning;
  // 首次同步时还没有收到 play 事件，但元数据只在开始播放时设置，先按播放中起服务，
  // 否则 Android 14+ 会因为「mediaPlayback 前台服务启动时没在播媒体」拒绝拉起
  if (isFirst) state.isPlaying = true;

  push(isFirst).catch((error) => console.warn('[nativeNowPlaying] 同步元数据失败', error));
};

/** 播放 / 暂停：只切播放态，避免重建通知造成闪烁 */
export const updateNowPlayingPlayback = (isPlaying: boolean) => {
  if (!isNative) return;

  state.isPlaying = isPlaying;

  if (!serviceRunning) {
    // 还没起过服务却又在播放（比如恢复播放），补一次完整同步
    if (!isPlaying) return;
    push(true).catch((error) => console.warn('[nativeNowPlaying] 启动媒体通知失败', error));
    return;
  }

  plugin.setPlaying({ isPlaying }).catch((error) => {
    console.warn('[nativeNowPlaying] 同步播放状态失败', error);
  });
};

/**
 * 进度变化：节流推送。
 *
 * `force` 用于播放态切换（播放/暂停）这种「位置必须准确」的时刻：原生 PlaybackState
 * 里只有 position，暂停时若报上去的还是上一次同步的旧位置，进度条就会跳回去。
 * 平时靠 rate 外推，慢一点无所谓，这里不能省。
 */
export const updateNowPlayingPosition = (
  position: number,
  duration: number,
  options?: { force?: boolean }
) => {
  if (!isNative || !serviceRunning) return;

  state.position = position;
  if (duration > 0) state.duration = duration;

  const now = Date.now();
  if (!options?.force && now - lastPositionAt < POSITION_THROTTLE_MS) return;
  lastPositionAt = now;

  plugin.update({ ...state }).catch((error) => {
    console.warn('[nativeNowPlaying] 同步播放进度失败', error);
  });
};

/** 停止播放：移除通知、释放 MediaSession 与音频焦点 */
export const stopNowPlaying = () => {
  if (!isNative || !serviceRunning) return;

  serviceRunning = false;
  state.isPlaying = false;
  plugin.stop().catch((error) => console.warn('[nativeNowPlaying] 停止媒体通知失败', error));
};

/**
 * 接住通知栏 / 锁屏 / 耳机按键发来的控制指令。
 * 走和 Web MediaSession 同一条处理路径，状态最终由事件总线同步回 store。
 */
export const initNativeNowPlaying = (handlers: NowPlayingHandlers) => {
  if (!isNative) return;

  console.log('[nativeNowPlaying] 注册原生控制指令监听');
  plugin
    .addListener('control', ({ action }) => {
      console.log('[nativeNowPlaying] 收到原生控制指令:', action);
      switch (action) {
        case 'play':
          handlers.onPlay();
          break;
        case 'pause':
          handlers.onPause();
          break;
        case 'next':
          handlers.onNext();
          break;
        case 'prev':
          handlers.onPrev();
          break;
        case 'stop':
          handlers.onStop();
          break;
        default:
          break;
      }
    })
    .catch((error) => console.warn('[nativeNowPlaying] 注册控制指令监听失败', error));
};
