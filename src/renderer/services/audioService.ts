import { Capacitor } from '@capacitor/core';
import { Howl, Howler } from 'howler';

import type { AudioOutputDevice } from '@/types/audio';
import type { SongResult } from '@/types/music';
import { getImgUrl, isElectron, toPlayableUrl } from '@/utils'; // 导入isElectron常量

import {
  updateNowPlayingMetadata,
  updateNowPlayingPlayback,
  updateNowPlayingPosition
} from './nativeNowPlaying';

class AudioService {
  private currentSound: Howl | null = null;
  private pendingSound: Howl | null = null;

  private currentTrack: SongResult | null = null;

  private context: AudioContext | null = null;

  private filters: BiquadFilterNode[] = [];

  private source: MediaElementAudioSourceNode | null = null;

  private gainNode: GainNode | null = null;

  private bypass = false;

  private playbackRate = 1.0; // 添加播放速度属性

  private currentSinkId: string = 'default';

  private contextStateMonitoringInitialized = false;

  // 预设的 EQ 频段
  private readonly frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  // 默认的 EQ 设置
  private defaultEQSettings: { [key: string]: number } = {
    '31': 0,
    '62': 0,
    '125': 0,
    '250': 0,
    '500': 0,
    '1000': 0,
    '2000': 0,
    '4000': 0,
    '8000': 0,
    '16000': 0
  };

  private retryCount = 0;

  private seekLock = false;

  private seekDebounceTimer: NodeJS.Timeout | null = null;

  // 添加操作锁防止并发操作
  private operationLock = false;
  private operationLockTimer: NodeJS.Timeout | null = null;
  private operationLockTimeout = 5000; // 5秒超时
  private operationLockStartTime: number = 0;
  private operationLockId: string = '';

  // ------------------------------------------------------------ 媒体会话状态核对
  //
  // 通知栏的进度条是按原生 PlaybackState 的 rate 外推出来的：只要上报过「在播」，
  // 它就自己往前跑，没人纠正就一直跑。所以「在播」必须是 <audio> 真的在响，
  // 不能是 howler 自己的记账（它只知道自己调没调过 play）。
  /** 最近一次上报给媒体会话的播放态 */
  private sessionPlayingReported = false;
  /** 核对定时器，只在「报着在播」时运行 */
  private playStateWatchdog: number | null = null;
  /** 连续几次核对都对不上才纠正，避免和刚发出的 play() 抢跑 */
  private playProbeMisses = 0;
  private readonly playProbeIntervalMs = 1000;
  private readonly playProbeMissesToFix = 2;

  /** 最近一次向上派发 end 的时间戳，用来丢掉重复的 end 事件（见 on('end') 处注释） */
  private lastEndAt = 0;

  constructor() {
    if ('mediaSession' in navigator) {
      this.initMediaSession();
    }
    // 从本地存储加载 EQ 开关状态
    const bypassState = localStorage.getItem('eqBypass');
    this.bypass = bypassState ? JSON.parse(bypassState) : false;

    // 页面加载时立即强制重置操作锁
    this.forceResetOperationLock();

    // 添加页面卸载事件，确保离开页面时清除锁
    window.addEventListener('beforeunload', () => {
      this.forceResetOperationLock();
    });
  }

  // 原生平台（Android）用 NowPlayingService 提供的系统媒体会话，
  // WebView 里的 navigator.mediaSession 没有 UI 载体，两边都注册只会互相抢媒体按键
  private readonly isNativePlatform = Capacitor.isNativePlatform();

  private initMediaSession() {
    if (this.isNativePlatform) return;

    navigator.mediaSession.setActionHandler('play', () => {
      this.handleMediaPlay();
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      this.handleMediaPause();
    });

    navigator.mediaSession.setActionHandler('stop', () => {
      this.stop();
    });

    navigator.mediaSession.setActionHandler('seekto', (event) => {
      if (event.seekTime && this.currentSound) {
        // this.currentSound.seek(event.seekTime);
        this.seek(event.seekTime);
      }
    });

    navigator.mediaSession.setActionHandler('seekbackward', (event) => {
      if (this.currentSound) {
        this.seek(this.getCurrentPosition() - (event.seekOffset || 10));
      }
    });

    navigator.mediaSession.setActionHandler('seekforward', (event) => {
      if (this.currentSound) {
        this.seek(this.getCurrentPosition() + (event.seekOffset || 10));
      }
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      // 这里需要通过回调通知外部
      this.emit('previoustrack');
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      // 这里需要通过回调通知外部
      this.emit('nexttrack');
    });
  }

  /**
   * 播放 / 暂停的统一入口，Web MediaSession 与 Android 通知栏共用这一份实现，
   * 避免两条路径的逻辑漂移。
   * 都先判一次当前状态：Chromium 和原生侧都可能同时收到同一次焦点变化，
   * 重复调用 howler 的 play() 会多起一个音源实例。
   */
  /**
   * 返回值表示「这条链路能不能自己处理」：false 时调用方应当走 store 那条完整播放链路。
   */
  public handleMediaPlay(): boolean {
    return this.resumeAtCurrentPosition();
  }

  /**
   * 接着当前进度恢复播放（而不是从头起）。
   *
   * 恢复播放入口原来都是裸调 `sound.play()`，html5 模式下这会「放到一半从头播」，
   * 根子在 howler 的记账和 `<audio>` 是两套状态：
   *
   * 1. `sound._seek` 不随播放前进，只在 play / seek / pause 时写入。元素被 howler 之外的
   *    东西暂停（Android 抢音频焦点、Windows 锁屏/休眠/别的应用出声、应用内 MV 的
   *    `<video>`）时 `_paused`、`_seek` 都不动，而 `play()` 开头就是
   *    `node.currentTime = seek`（howler 源码 playHtml5 第一行）——拿的是整首歌开始时那个
   *    值，也就是 0。
   * 2. 同一个原因，howler 仍认为自己在播，`play()` 里数不到「暂停且未结束」的实例，于是走
   *    `_inactiveSound()` 另起一个音源：新 `<audio>` 从 0 播，旧的留在 `_sounds[0]`，
   *    进度条、歌词和媒体会话的进度从此停在原地不动——看起来就像「换了个资源在放」。
   *
   * 对齐靠 `seek()`：它内部会先 `pause(id, true)` 把 `_seek` 从元素同步回来并置 `_paused`，
   * 再写位置，最后在「原本在播」时用 `play(id)` 续上——带 id 就不会另起实例。
   *
   * @param target 续播位置（秒）；不传则取 `<audio>` 的真实进度，元素才是唯一不会骗人的进度源
   * @returns 是否已由本方法接续；false 表示内部状态没法就地补救，调用方该走完整的重建链路
   */
  public resumeAtCurrentPosition(target?: number): boolean {
    return this.resumeAt(this.currentSound, target);
  }

  /**
   * 让指定 Howl 在 `target`（不传则取其 `<audio>` 的真实进度）处接着播。
   * 用它的原因和内部机制见 {@link resumeAtCurrentPosition}。
   */
  public resumeAt(sound: Howl | null | undefined, target?: number): boolean {
    const raw = sound as any;
    const items = raw?._sounds as any[] | undefined;

    // `_state === 'unloaded'` 也要挡住：playerCore 重建播放链路时会先把当前实例 unload 掉
    // 再解析新地址，中间这段时间 currentSound 是一个已经卸载的 Howl，拿不出进度，
    // 在这里起播只会从头开始。如实交出去，让上层走完整流程（它会从 playProgress 恢复进度）。
    if (!sound || !items?.length || raw._state === 'unloaded') {
      console.warn('[audioService] 恢复播放：没有可用的音频实例，交给上层重建播放链路');
      return false;
    }

    const node = this.nodeOf(sound);
    const snd = items[0];
    const position =
      typeof target === 'number'
        ? target
        : typeof node?.currentTime === 'number'
          ? node.currentTime
          : 0;

    console.log(
      `[audioService] 恢复播放: node=${!!node} paused=${node?.paused} ended=${node?.ended}` +
        ` readyState=${node?.readyState} networkState=${node?.networkState}` +
        ` 元素位置=${position.toFixed(2)}s` +
        ` howlerPlaying=${sound.playing()} playLock=${raw._playLock} state=${raw._state}` +
        ` sndPaused=${snd._paused} sndEnded=${snd._ended} sndSeek=${snd._seek}`
    );

    // 没指定位置、元素又真的在响 —— 什么都不用做。重复 play() 只会多起一个实例。
    // 用底层 <audio> 判断而不是 howler 的 playing()：被外部掐断之后（应用内 MV / 直播
    // 抢走音频焦点、系统打断）howler 仍然认为自己在播，`!playing()` 不成立，
    // 这里就什么都不做，通知栏的播放键成了摆设。以 DOM 为准，只有真的在响才跳过。
    if (typeof target !== 'number' && node && !node.paused && !node.ended) return true;

    if (!node) {
      // 拿不到节点（Web Audio 模式）就没有 DOM 进度可对齐，退回 howler 自己的记账：
      // 那种模式下 `_seek` 由音频时钟维护，确实是可靠的。带 id 起播，避免另起实例。
      sound.play(snd._id);
      return true;
    }

    // howler 口径的「在播」要在 seek 之前取：它决定 seek() 之后还要不要手动起播。
    const wasPlaying = sound.playing();

    // 这一步同时完成三件事：把 `_seek`/`_ended`/`_paused` 与元素对齐、把位置挪到 position、
    // 并在原本在播时用 play(id) 自己续上（不会是裸 play()，所以不会另起实例）。
    sound.seek(position);

    // seek() 在 howler 的 _playLock 卡住、或音频还没 loaded 时只会把这次定位塞进 _queue
    // 等后续处理，本次恢复就落空了。落空时按元素的事实把内部状态摆正——位置、未结束、
    // 已暂停，正是 pause() + seek() 正常跑完后的样子（不动 _id，实例还是这一个）。
    let needPlay = !wasPlaying;
    if (snd._seek !== position || snd._paused !== true) {
      console.warn(
        `[audioService] seek 没把内部状态对齐（playLock=${raw._playLock} state=${raw._state}` +
          ` sndPaused=${snd._paused} sndSeek=${snd._seek}），按元素事实手工摆正`
      );
      snd._seek = position;
      snd._ended = false;
      snd._paused = true;
      try {
        node.currentTime = position;
      } catch (error) {
        console.error('[audioService] 对齐元素进度失败:', error);
      }
      // seek() 没生效，也就不会有它那次续播
      needPlay = true;
    }

    // 带 id 起播：指定 id 时 howler 走 `_soundById()`，不会碰 `_inactiveSound()`，实例不会翻倍。
    // 也刻意不在这里判 playing()——那又变成拿 howler 的记账做决定了。
    if (needPlay) sound.play(snd._id);
    return true;
  }

  public handleMediaPause() {
    if (this.currentSound?.playing()) {
      this.currentSound.pause();
    }
  }

  /**
   * 底层 `<audio>` 是否确实停着（暂停 / 已结束 / 节点还没建出来）。
   *
   * 给「暂停态又收到 pause」那条兜底用。这里刻意不读 howler 的 playing()，
   * 也不读原生上报的播放态：只有元素本身的状态不会落后。
   */
  public isMediaActuallyPaused(): boolean {
    const node = this.nodeOf(this.currentSound);
    return !node || node.paused || node.ended;
  }

  private updateMediaSessionMetadata(track: SongResult) {
    const artists = track.ar ? track.ar.map((a) => a.name) : track.song.artists?.map((a) => a.name);
    const album = track.al ? track.al.name : track.song.album.name;

    // 原生平台的通知栏只需要一张最大尺寸的封面。
    // 只有 http(s) 的绝对地址才传过去：原生侧是自己拿 HttpURLConnection 去下的，
    // 内置兜底封面那种相对路径（/images/default_cover.png）和 local:// 它都够不着，
    // 传过去只是白跑一趟并让日志里多一条“下载失败”。传空则会退到应用图标兜底。
    const cover =
      track.picUrl && /^https?:/i.test(track.picUrl) ? getImgUrl(track.picUrl, '512y512') : '';
    updateNowPlayingMetadata({
      title: track.name || '',
      artist: artists ? artists.join(',') : '',
      album: album || '',
      cover
    });

    try {
      if (!('mediaSession' in navigator) || this.isNativePlatform) return;

      const artwork = ['96', '128', '192', '256', '384', '512'].map((size) => ({
        src: `${track.picUrl}?param=${size}y${size}`,
        type: 'image/jpg',
        sizes: `${size}x${size}`
      }));
      const metadata = {
        title: track.name || '',
        artist: artists ? artists.join(',') : '',
        album: album || '',
        artwork
      };

      navigator.mediaSession.metadata = new window.MediaMetadata(metadata);
    } catch (error) {
      console.error('更新媒体会话元数据时出错:', error);
    }
  }

  /**
   * 把播放态同步给媒体会话（原生通知栏 / Web MediaSession）。
   *
   * 上报「在播」之前会拿底层 `<audio>` 复核一次：howler 的 play 事件、调用方的判断，
   * 说的都只是「调了 play()」，元素有没有真的响起来是另一回事——同页面的 `<video>`
   * （应用内 MV / 直播）抢走播放、系统打断，都会让元素停在 paused。
   *
   * 原生通知栏的进度条按 PlaybackState 的 rate 外推，一旦把假的「在播」报上去，
   * 它就自己往前跑，而这时往往一个事件都不会再有（元素既没起来、也没有 pause 事件），
   * 于是通知栏永远显示播放、时间一直涨。所以这里以 DOM 为准，复核不过就按暂停报。
   *
   * 只纠正「报给媒体会话」的这一份，不改 store、不派发事件——「这次到底起没起来、
   * 要不要重试」由 playerCore 的 checkPlaybackState 负责，两边各管各的，不互相打架。
   */
  private updateMediaSessionState(isPlaying: boolean, sound: Howl | null = this.currentSound) {
    let effective = isPlaying;
    if (isPlaying && !this.isSoundActuallyPlaying(sound)) {
      console.warn('[audioService] 请求上报「在播」，但 <audio> 并未真的在播放，改按暂停上报');
      effective = false;
    }

    this.sessionPlayingReported = effective;

    // 先推位置、再切播放态，顺序不能反：原生 PlaybackState 里只有 position 和 rate 两个数，
    // 位置不刷新的话，暂停时进度条会被定位到最后一次同步的位置——而那个值整首歌都停在 0
    // （只有换歌和 seek 时才推过），看起来就是「一按暂停时间条被清空」；恢复播放也会从 0 重跑。
    // 反过来先切播放态的话，中间会有一帧「暂停在 0」，进度条要闪一下。
    this.pushCurrentPosition(true);
    updateNowPlayingPlayback(effective);

    if (effective) {
      this.startPlayStateWatchdog();
    } else {
      this.stopPlayStateWatchdog();
    }

    if (!('mediaSession' in navigator) || this.isNativePlatform) return;

    navigator.mediaSession.playbackState = effective ? 'playing' : 'paused';
    this.updateMediaSessionPositionState();
  }

  /**
   * 取某个 Howl 底层的 `<audio>` 元素。
   * html5 模式下 `_node` 就是真正发声的元素；Web Audio 模式（桌面端开 EQ 走这条）
   * 是 GainNode，没有 DOM 状态可查，返回 undefined。
   *
   * 挑节点时不能死盯 `_sounds[0]`：howler 在「以为自己还在播、实际元素已经停了」的状态下
   * 被再 `play()` 一次，会往 `_sounds` 后面追加一个新 Sound（见 howler 的 `_inactiveSound`），
   * 旧的那个仍留在 `_sounds[0]`。此时 `_sounds[0]` 指的是停住的旧节点，媒体会话的进度、
   * 播放态核对全会跟着错位，所以优先挑正在发声的那个；都不在响就退到最后一个——追加的实例
   * 总是排在后面。（这种情况本身已由 {@link resumeAt} 堵住，这里是兜底。）
   */
  private nodeOf(sound: Howl | null | undefined): HTMLMediaElement | undefined {
    const items = (sound as any)?._sounds as any[] | undefined;
    if (!items?.length) return undefined;

    let last: HTMLMediaElement | undefined;
    for (const item of items) {
      const node = item?._node;
      if (!(node instanceof HTMLMediaElement)) continue;
      if (!node.paused && !node.ended) return node;
      last = node;
    }
    return last;
  }

  /**
   * 实例还活着吗。
   *
   * `stop()` + `unload()` 之后 howler 会把 `_state` 置成 `unloaded`、清掉 `_node`，但实例
   * 本身还挂在 `currentSound` 上——这时 {@link getCurrentPosition} 读不出位置，只能返回 0。
   *
   * 需要区分「真的播到 0 秒」和「读不出来」的地方都得先问一句。最典型的是往 localStorage
   * 落进度的心跳：切歌/重建中间有 `await`（取歌词、背景色、解析地址），50ms 一拍的心跳
   * 必然落进这个空档，把 0 写成真实进度，之后任何按 `playProgress` 恢复的入口都会从头播。
   */
  public isSoundUsable(sound?: Howl | null): boolean {
    const target = sound === undefined ? this.currentSound : sound;
    if (!target) return false;

    const anySound = target as any;
    return (
      anySound._state === 'loaded' &&
      // Web Audio 模式下进度由音频时钟维护，没有元素也读得准
      (anySound._webAudio || !!this.nodeOf(target))
    );
  }

  /**
   * 播放进度（秒），以底层 `<audio>` 为准。
   *
   * `Howl.seek()` 读的是 `_sounds[0]`，双实例时那可能是被丢下的旧节点（见 {@link nodeOf}），
   * 进度会一直冻在旧位置。拿不到节点（Web Audio 模式）时才退回 howler 的记账。
   * `Howl.seek()` 在定位被塞进 `_queue` 时会返回 Howl 自身，所以这里统一收口成数字。
   *
   * 注意 0 是「读不出来」和「真在开头」共用的返回值，要区分的调用方先过
   * {@link isSoundUsable}。
   */
  public getCurrentPosition(sound?: Howl | null): number {
    const target = sound === undefined ? this.currentSound : sound;
    if (!target) return 0;

    const node = this.nodeOf(target);
    const position = node ? node.currentTime : (target.seek() as number);
    return typeof position === 'number' && !Number.isNaN(position) ? position : 0;
  }

  /**
   * 把底层 `<audio>` 的当前进度推给媒体会话。
   * `force` 时跳过节流——播放态切换必须带上准确的位置，等不起。
   */
  private pushCurrentPosition(force = false) {
    if (!this.currentSound) return;

    updateNowPlayingPosition(this.getCurrentPosition(), this.currentSound.duration() as number, {
      force
    });
  }

  /**
   * `<audio>` 是否真的在发声。取不到节点时返回 true——宁可不纠正，
   * 也不要凭着猜测把状态改成暂停。
   */
  private isSoundActuallyPlaying(sound: Howl | null | undefined): boolean {
    const node = this.nodeOf(sound);
    if (!node) return true;
    return !node.paused && !node.ended;
  }

  /**
   * 看门狗：只要媒体会话还「报着在播」，就每秒拿底层 `<audio>` 复核一次。
   *
   * 光靠事件纠正不够。元素被掐断时可能一个事件都没有（同页 `<video>` 占着播放、
   * 系统把音频停掉而 WebView 没派发事件），而通知栏的进度条不等人。这里不派发任何事件，
   * 只把媒体会话拉回真实状态。
   */
  private startPlayStateWatchdog() {
    if (this.playStateWatchdog !== null) return;

    this.playStateWatchdog = window.setInterval(() => {
      if (!this.sessionPlayingReported) {
        this.stopPlayStateWatchdog();
        return;
      }

      const node = this.nodeOf(this.currentSound);
      // 节点没了 / 媒体被卸载（换歌、stop）不算分歧，换歌流程自己会重报状态
      if (!node || node.readyState === 0) {
        this.playProbeMisses = 0;
        return;
      }
      if (!node.paused && !node.ended) {
        this.playProbeMisses = 0;
        return;
      }

      if (++this.playProbeMisses < this.playProbeMissesToFix) return;
      this.playProbeMisses = 0;
      console.warn('[audioService] 媒体会话报着在播，但 <audio> 实际没在播放，纠正为暂停');
      this.updateMediaSessionState(false, this.currentSound);
    }, this.playProbeIntervalMs);
  }

  private stopPlayStateWatchdog() {
    if (this.playStateWatchdog !== null) {
      window.clearInterval(this.playStateWatchdog);
      this.playStateWatchdog = null;
    }
    this.playProbeMisses = 0;
  }

  private updateMediaSessionPositionState() {
    try {
      if (!this.currentSound) return;

      const duration = this.currentSound.duration();
      const position = this.getCurrentPosition();
      updateNowPlayingPosition(position, duration);

      if (!('mediaSession' in navigator) || this.isNativePlatform) return;
      if ('setPositionState' in navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: this.playbackRate,
          position
        });
      }
    } catch (error) {
      console.error('更新媒体会话位置状态时出错:', error);
    }
  }

  // 事件处理相关
  private callbacks: { [key: string]: Function[] } = {};

  private emit(event: string, ...args: any[]) {
    const eventCallbacks = this.callbacks[event];
    if (eventCallbacks) {
      eventCallbacks.forEach((callback) => callback(...args));
    }
  }

  on(event: string, callback: Function) {
    if (!this.callbacks[event]) {
      this.callbacks[event] = [];
    }
    this.callbacks[event].push(callback);
  }

  off(event: string, callback: Function) {
    const eventCallbacks = this.callbacks[event];
    if (eventCallbacks) {
      this.callbacks[event] = eventCallbacks.filter((cb) => cb !== callback);
    }
  }

  // EQ 相关方法
  public isEQEnabled(): boolean {
    return !this.bypass;
  }

  public setEQEnabled(enabled: boolean) {
    this.bypass = !enabled;
    localStorage.setItem('eqBypass', JSON.stringify(this.bypass));

    if (this.source && this.gainNode && this.context) {
      this.applyBypassState();
    }
  }

  public setEQFrequencyGain(frequency: string, gain: number) {
    const filterIndex = this.frequencies.findIndex((f) => f.toString() === frequency);
    if (filterIndex !== -1 && this.filters[filterIndex]) {
      this.filters[filterIndex].gain.setValueAtTime(gain, this.context?.currentTime || 0);
      this.saveEQSettings(frequency, gain);
    }
  }

  public resetEQ() {
    this.filters.forEach((filter) => {
      filter.gain.setValueAtTime(0, this.context?.currentTime || 0);
    });
    localStorage.removeItem('eqSettings');
  }

  public getAllEQSettings(): { [key: string]: number } {
    return this.loadEQSettings();
  }

  private saveEQSettings(frequency: string, gain: number) {
    const settings = this.loadEQSettings();
    settings[frequency] = gain;
    localStorage.setItem('eqSettings', JSON.stringify(settings));
  }

  private loadEQSettings(): { [key: string]: number } {
    const savedSettings = localStorage.getItem('eqSettings');
    return savedSettings ? JSON.parse(savedSettings) : { ...this.defaultEQSettings };
  }

  private async disposeEQ(keepContext = false) {
    try {
      // 清理音频节点连接
      if (this.source) {
        this.source.disconnect();
        this.source = null;
      }

      // 清理滤波器
      this.filters.forEach((filter) => {
        try {
          filter.disconnect();
        } catch (e) {
          console.warn('清理滤波器时出错:', e);
        }
      });
      this.filters = [];

      // 清理增益节点
      if (this.gainNode) {
        this.gainNode.disconnect();
        this.gainNode = null;
      }

      // 如果不需要保持上下文，则关闭它
      if (!keepContext && this.context) {
        try {
          await this.context.close();
          this.context = null;
        } catch (e) {
          console.warn('关闭音频上下文时出错:', e);
        }
      }
    } catch (error) {
      console.error('清理EQ资源时出错:', error);
    }
  }

  private async setupEQ(sound: Howl) {
    // 提到 try 外面：失败时要拿它把「元素已被接管」这件事补救回来（见 catch）
    let audioNode: HTMLMediaElement | undefined;

    try {
      if (!isElectron) {
        console.log('Web环境中跳过EQ设置，避免CORS问题');
        this.bypass = true;
        return;
      }
      // 取正在发声的那个节点（双实例时 `_sounds[0]` 可能是被丢下的旧节点，见 nodeOf）：
      // 只把真正出声的元素接进 EQ 图，否则 EQ 作用在一个哑巴节点上，等于没有 EQ。
      audioNode = this.nodeOf(sound);

      if (!audioNode) {
        if (this.retryCount < 3) {
          console.warn('等待音频节点初始化，重试次数:', this.retryCount + 1);
          await new Promise((resolve) => setTimeout(resolve, 100));
          this.retryCount++;
          return await this.setupEQ(sound);
        }
        throw new Error('无法获取音频节点，请重试');
      }

      this.retryCount = 0;

      // 确保使用 Howler 的音频上下文
      this.context = Howler.ctx as AudioContext;

      if (!this.context || this.context.state === 'closed') {
        Howler.ctx = new AudioContext();
        this.context = Howler.ctx;
        Howler.masterGain = this.context.createGain();
        Howler.masterGain.connect(this.context.destination);
      }

      if (this.context.state === 'suspended') {
        await this.context.resume();
      }

      // 设置 AudioContext 状态监控
      this.setupContextStateMonitoring();

      // 恢复保存的音频输出设备
      this.restoreSavedAudioDevice();

      // 清理现有连接
      await this.disposeEQ(true);

      try {
        // 检查节点是否已经有源
        const existingSource = (audioNode as any).source as MediaElementAudioSourceNode;
        if (existingSource?.context === this.context) {
          console.log('复用现有音频源节点');
          this.source = existingSource;
        } else {
          // 创建新的源节点
          console.log('创建新的音频源节点');
          this.source = this.context.createMediaElementSource(audioNode);
          (audioNode as any).source = this.source;
        }
      } catch (e) {
        // 这个元素已经被别的 AudioContext 接管过（多半是那个上下文已经被关掉了）。
        // Chromium 对「同一个 <audio> 被接管过」这件事是终身记忆的：再建 source 一律抛
        // InvalidStateError，而且这个元素从此就是个哑巴——paused 一直是 false、currentTime
        // 却冻住不动、永远发不出声。记下来，别让它顺着 howler 的复用池传染给后面每一首。
        this.poisonedNodes.add(audioNode);
        console.error('创建音频源节点失败:', e);
        throw e;
      }

      // 创建增益节点
      this.gainNode = this.context.createGain();

      // 创建滤波器
      this.filters = this.frequencies.map((freq) => {
        const filter = this.context!.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1;
        filter.gain.value = this.loadEQSettings()[freq.toString()] || 0;
        return filter;
      });

      // 应用EQ状态
      this.applyBypassState();

      // 从 localStorage 应用音量到增益节点
      const savedVolume = localStorage.getItem('volume');
      if (savedVolume) {
        this.applyVolume(parseFloat(savedVolume));
      } else {
        this.applyVolume(1);
      }

      console.log('EQ initialization successful');
    } catch (error) {
      console.error('EQ initialization failed:', error);
      // 保留上下文，理由和 stop() 里那段一样：关掉它会把池子里的元素一个个变成哑巴
      await this.disposeEQ(true);

      // 元素被接管过的那种失败救不回来（它已经出不了声了），如实往上报，让上层重建
      // 播放链路；重试时这个元素已被剔出复用池（见 evictPoisonedNodes），会拿到干净的。
      if ((error as { name?: string } | null)?.name === 'InvalidStateError') {
        throw error;
      }

      // 其它原因（节点没就绪、图连不上……）就只是这次没有 EQ：元素没被接管时本来就是
      // 直接出声，不该为了 EQ 把整首歌废掉。
      // 但「接管」是从 source 建好那一刻生效的：声音从此只走 AudioContext，把图一断了之
      // 等于把元素插到一个不通的插座上——又是无声。所以这里退化成直通连接（source 直接
      // 接输出），用户得到的是没有 EQ 的正常声音，而不是一首哑歌。
      const hijacked = (audioNode as { source?: MediaElementAudioSourceNode } | undefined)?.source;
      if (hijacked && this.context) {
        try {
          hijacked.disconnect();
        } catch {
          /* 已经断开 */
        }
        try {
          hijacked.connect(this.context.destination);
          console.warn('[audioService] EQ 图没搭起来，已把音频源直连输出（本次播放无 EQ）');
        } catch (connectError) {
          console.error('[audioService] 直连输出也失败，本次播放可能无声:', connectError);
        }
      }

      console.warn('[audioService] EQ 初始化失败，本次播放降级为无 EQ');
    }
  }

  private applyBypassState() {
    if (!this.source || !this.gainNode || !this.context) return;

    try {
      // 断开所有现有连接（捕获已断开的错误）
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
      this.filters.forEach((filter) => {
        try {
          filter.disconnect();
        } catch {
          /* already disconnected */
        }
      });
      try {
        this.gainNode.disconnect();
      } catch {
        /* already disconnected */
      }

      if (this.bypass) {
        // EQ被禁用时，直接连接到输出
        this.source.connect(this.gainNode);
        this.gainNode.connect(this.context.destination);
      } else {
        // EQ启用时，通过滤波器链连接
        this.source.connect(this.filters[0]);
        this.filters.forEach((filter, index) => {
          if (index < this.filters.length - 1) {
            filter.connect(this.filters[index + 1]);
          }
        });
        this.filters[this.filters.length - 1].connect(this.gainNode);
        this.gainNode.connect(this.context.destination);
      }
    } catch (error) {
      console.error('Error applying EQ state, attempting fallback:', error);
      // Fallback: connect source directly to destination
      try {
        if (this.source && this.context) {
          this.source.connect(this.context.destination);
          console.log('Fallback: connected source directly to destination');
        }
      } catch (fallbackError) {
        console.error('Fallback connection also failed:', fallbackError);
        this.emit('audio_error', { type: 'graph_disconnected', error: fallbackError });
      }
    }
  }

  // 设置操作锁，带超时自动释放
  private setOperationLock(): boolean {
    // 生成唯一的锁ID
    const lockId = Date.now().toString() + Math.random().toString(36).substring(2, 9);

    // 如果锁已经存在，检查是否超时
    if (this.operationLock) {
      const currentTime = Date.now();
      const lockDuration = currentTime - this.operationLockStartTime;

      // 如果锁持续时间超过2秒，直接强制重置
      if (lockDuration > 2000) {
        console.warn(`操作锁已激活 ${lockDuration}ms，超过安全阈值，强制重置`);
        this.forceResetOperationLock();
      } else {
        console.log(`操作锁激活中，持续时间 ${lockDuration}ms`);
        return false;
      }
    }

    this.operationLock = true;
    this.operationLockStartTime = Date.now();
    this.operationLockId = lockId;

    // 将锁信息存储到 localStorage（仅用于调试，实际不依赖此值）
    try {
      localStorage.setItem(
        'audioOperationLock',
        JSON.stringify({
          id: this.operationLockId,
          startTime: this.operationLockStartTime
        })
      );
    } catch (error) {
      console.error('存储操作锁信息失败:', error);
    }

    // 清除之前的定时器
    if (this.operationLockTimer) {
      clearTimeout(this.operationLockTimer);
    }

    // 设置超时自动释放锁
    this.operationLockTimer = setTimeout(() => {
      console.warn('操作锁超时自动释放');
      this.releaseOperationLock();
    }, this.operationLockTimeout);

    return true;
  }

  // 释放操作锁
  public releaseOperationLock(): void {
    this.operationLock = false;
    this.operationLockStartTime = 0;

    // 从 localStorage 中移除锁信息
    try {
      localStorage.removeItem('audioOperationLock');
    } catch (error) {
      console.error('清除存储的操作锁信息失败:', error);
    }

    if (this.operationLockTimer) {
      clearTimeout(this.operationLockTimer);
      this.operationLockTimer = null;
    }
  }

  // 强制重置操作锁，用于特殊情况
  public forceResetOperationLock(): void {
    console.log('强制重置操作锁');
    this.operationLock = false;
    this.operationLockStartTime = 0;
    this.operationLockId = '';

    if (this.operationLockTimer) {
      clearTimeout(this.operationLockTimer);
      this.operationLockTimer = null;
    }

    // 清除存储的锁
    localStorage.removeItem('audioOperationLock');
  }

  // 播放控制相关
  public play(
    url: string,
    track: SongResult,
    isPlay: boolean = true,
    seekTime: number = 0,
    existingSound?: Howl
  ): Promise<Howl> {
    // 如果没有提供新的 URL 和 track，且当前有音频实例，则继续播放当前音频
    if (this.currentSound && !url && !track) {
      if (this.seekLock && this.seekDebounceTimer) {
        clearTimeout(this.seekDebounceTimer);
        this.seekLock = false;
      }
      // 走对齐后的续播，别裸 play()：元素被外部暂停过的话会把歌倒回开头
      this.resumeAt(this.currentSound);
      return Promise.resolve(this.currentSound);
    }

    // 新播放请求：强制重置旧锁，确保不会被遗留锁阻塞
    this.forceResetOperationLock();

    // 获取操作锁
    if (!this.setOperationLock()) {
      // 理论上不会到这里（刚刚 forceReset 过），但作为防御性编程
      console.warn('audioService: 获取操作锁失败，强制继续');
      this.forceResetOperationLock();
      this.setOperationLock();
    }

    // 如果没有提供必要的参数，返回错误
    if (!url || !track) {
      this.releaseOperationLock();
      return Promise.reject(new Error('缺少必要参数: url和track'));
    }

    // 检查是否是同一首歌曲的无缝切换（Hot-Swap）。
    // 「上一首还活着」是前提：playerCore 重建播放链路时会先 stop + unload 掉当前实例，
    // 再解析新地址；到这里 `currentSound` 往往已经是个 `_state === 'unloaded'`、
    // `_sounds` 被清空过的 Howl。拿它同步进度只会得到 0——howler 的 `seek()` 在未加载时
    // 既不读元素也没有元素可读（见 getCurrentPosition），于是这一首从中途重头放。
    // 恢复位该由调用方通过 `seekTime` 传进来（playerCore.playAudio 从 playProgress 取）。
    const previousUsable = this.isSoundUsable();
    const isHotSwap = !!(
      this.currentTrack &&
      track &&
      this.currentTrack.id === track.id &&
      previousUsable
    );

    if (isHotSwap) {
      console.log('audioService: 检测到同一首歌曲的源切换，启用无缝切换模式');
    }

    return new Promise<Howl>((resolve, reject) => {
      let retryCount = 0;
      const maxRetries = 1;

      // 如果有正在加载的 pendingSound，先清理掉
      if (this.pendingSound) {
        console.log('audioService: 清理正在加载的 pendingSound');
        this.pendingSound.unload();
        this.pendingSound = null;
      }

      const tryPlay = async () => {
        try {
          console.log('audioService: 开始创建音频对象');

          // 建 Howl 之前先清池子：哑巴元素一旦被发出来，这一首就白搭了
          this.evictPoisonedNodes();

          // 确保 Howler 上下文已初始化
          if (!Howler.ctx) {
            console.log('audioService: 初始化 Howler 上下文');
            Howler.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          }

          // 确保使用同一个音频上下文
          if (Howler.ctx.state === 'closed') {
            console.log('audioService: 重新创建音频上下文');
            Howler.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            this.context = Howler.ctx;
            Howler.masterGain = this.context.createGain();
            Howler.masterGain.connect(this.context.destination);
            // 重新创建上下文后恢复输出设备
            this.restoreSavedAudioDevice();
          }

          // 恢复上下文状态
          if (Howler.ctx.state === 'suspended') {
            console.log('audioService: 恢复暂停的音频上下文');
            await Howler.ctx.resume();
          }

          // 非热切换模式下，先停止并清理现有的音频实例
          if (!isHotSwap && this.currentSound) {
            console.log('audioService: 停止并清理现有的音频实例');
            // 确保任何进行中的seek操作被取消
            if (this.seekLock && this.seekDebounceTimer) {
              clearTimeout(this.seekDebounceTimer);
              this.seekLock = false;
            }
            this.currentSound.stop();
            this.currentSound.unload();
            this.currentSound = null;
          }

          // 清理 EQ 但保持上下文 (热切换时暂时不清理，等切换完成后再处理)
          if (!isHotSwap) {
            console.log('audioService: 清理 EQ');
            await this.disposeEQ(true);
          }

          // 如果不是热切换，立即更新 currentTrack
          if (!isHotSwap) {
            this.currentTrack = track;
          }

          let newSound: Howl;

          if (existingSound) {
            console.log('audioService: 使用预加载的 Howl 对象');
            newSound = existingSound;
            // 确保 volume 和 rate 正确
            newSound.volume(1); // 内部 volume 设为 1，由 Howler.masterGain 控制实际音量
            newSound.rate(this.playbackRate);

            // 重新绑定事件监听器，因为 PreloadService 可能没有绑定这些
            // 注意：Howler 允许重复绑定，但最好先清理（如果无法清理，就直接绑定，Howler 是 EventEmitter）
            // 这里我们假设 existingSound 是干净的或者我们只绑定我们需要关心的
          } else {
            console.log('audioService: 创建新的 Howl 对象');
            newSound = new Howl({
              src: [toPlayableUrl(url)],
              html5: true,
              autoplay: false,
              volume: 1, // 禁用 Howler.js 音量控制
              rate: this.playbackRate,
              format: ['mp3', 'aac']
            });
          }

          // 统一设置事件处理
          const setupEvents = () => {
            newSound.off('loaderror');
            newSound.off('playerror');
            newSound.off('load');

            newSound.on('loaderror', (_, error) => {
              console.error('Audio load error:', error);
              this.emit('loaderror', { track, error });
              if (retryCount < maxRetries && !existingSound) {
                // 预加载的音频通常已经 loaded，不应重试
                retryCount++;
                console.log(`Retrying playback (${retryCount}/${maxRetries})...`);
                setTimeout(tryPlay, 1000 * retryCount);
              } else {
                this.emit('url_expired', track);
                this.releaseOperationLock();
                if (isHotSwap) this.pendingSound = null;
                reject(new Error('音频加载失败，请尝试切换其他歌曲'));
              }
            });

            newSound.on('playerror', (_, error) => {
              console.error('Audio play error:', error);
              // howler 起播失败时只会发 playerror，媒体会话那边还停在上一轮的「在播」上，
              // 通知栏于是继续显示播放、进度条继续跑。这里如实改成暂停。
              this.updateMediaSessionState(false, newSound);
              this.emit('playerror', { track, error });
              if (retryCount < maxRetries) {
                retryCount++;
                console.log(`Retrying playback (${retryCount}/${maxRetries})...`);
                setTimeout(tryPlay, 1000 * retryCount);
              } else {
                this.emit('url_expired', track);
                this.releaseOperationLock();
                if (isHotSwap) this.pendingSound = null;
                reject(new Error('音频播放失败，请尝试切换其他歌曲'));
              }
            });

            const onLoaded = async () => {
              try {
                // 如果是热切换，现在执行切换逻辑
                if (isHotSwap) {
                  console.log('audioService: 执行无缝切换');

                  // 1. 获取当前播放进度或使用指定的 seekTime
                  let targetPos = 0;
                  if (seekTime > 0) {
                    // 如果有指定的 seekTime（如恢复播放进度），优先使用
                    targetPos = seekTime;
                    console.log(`audioService: 使用指定的 seekTime: ${seekTime}s`);
                  } else if (this.currentSound) {
                    // 否则同步当前进度：取元素的真实进度，别用 howler 的记账（它可能停在
                    // 这首歌开始时那个值上，切过去就成了从 0 重放）
                    targetPos = this.getCurrentPosition();
                  }

                  // 2. 同步新音频进度
                  newSound.seek(targetPos);

                  // 3. 初始化新音频的 EQ
                  await this.disposeEQ(true);
                  await this.setupEQ(newSound);

                  // 4. 播放新音频
                  // 这里是新实例的首次起播，上面那步 seek(targetPos) 已经把 `_seek` 写好、
                  // 并把 `_paused = true / _ended = false` 摆成唯一一个「暂停且未结束」的实例，
                  // howler 的 play() 会因为这唯一性而复用它并从 targetPos 播——不会从头开始。
                  // （恢复播放入口不满足这个前提，必须走 resumeAt，见那里的注释。）
                  if (isPlay) {
                    newSound.play();
                  }

                  // 5. 停止旧音频
                  if (this.currentSound) {
                    this.currentSound.stop();
                    this.currentSound.unload();
                  }

                  // 6. 更新引用
                  this.currentSound = newSound;
                  this.currentTrack = track;
                  this.pendingSound = null;

                  console.log(`audioService: 无缝切换完成，进度同步至 ${targetPos}s`);
                } else {
                  // 普通加载逻辑
                  await this.setupEQ(newSound);
                  this.currentSound = newSound;
                }

                // 重新应用已保存的音量
                const savedVolume = localStorage.getItem('volume');
                if (savedVolume) {
                  this.applyVolume(parseFloat(savedVolume));
                }

                if (this.currentSound) {
                  try {
                    if (!isHotSwap && seekTime > 0) {
                      this.currentSound.seek(seekTime);
                    }

                    console.log('audioService: 音频加载成功，设置 EQ');
                    this.updateMediaSessionMetadata(track);
                    this.updateMediaSessionPositionState();
                    this.emit('load');

                    if (!isHotSwap) {
                      console.log('audioService: 音频完全初始化，isPlay =', isPlay);
                      if (isPlay) {
                        console.log('audioService: 开始播放');
                        // 同上：新实例首次起播，`_seek` 已被上面的 seek(seekTime) 写好，
                        // 没有「howler 以为在播」这个前提，裸 play() 是安全的
                        this.currentSound.play();
                      }
                    }

                    resolve(this.currentSound);
                  } catch (error) {
                    console.error('Audio initialization failed:', error);
                    reject(error);
                  }
                }
              } catch (error) {
                console.error('Audio initialization failed:', error);
                reject(error);
              }
            };

            if (newSound.state() === 'loaded') {
              onLoaded();
            } else {
              newSound.once('load', onLoaded);
            }
          };

          setupEvents();

          if (isHotSwap) {
            this.pendingSound = newSound;
          } else {
            this.currentSound = newSound;
          }

          // 设置音频事件监听 (play, pause, end, seek)
          // ... (保持原有的事件监听逻辑不变，但需要确保绑定到 newSound)
          const soundInstance = newSound;
          if (soundInstance) {
            // 清除旧的监听器以防重复
            soundInstance.off('play');
            soundInstance.off('pause');
            soundInstance.off('end');
            soundInstance.off('seek');

            soundInstance.on('play', () => {
              if (this.currentSound === soundInstance) {
                // 带上实例：上报前要拿它自己的 <audio> 复核，热切换期间 currentSound 可能已经换人
                this.updateMediaSessionState(true, soundInstance);
                this.emit('play');
              }
            });

            soundInstance.on('pause', () => {
              if (this.currentSound === soundInstance) {
                this.updateMediaSessionState(false, soundInstance);
                this.emit('pause');
              }
            });

            soundInstance.on('end', () => {
              if (this.currentSound !== soundInstance) return;
              // howler 每次 play() 都会给 `_endTimers[id]` 挂一个新的 ended 监听器，而
              // `_endTimers` 只存得下最后一个——被覆盖掉的那些没人摘，最后一次播放结束时
              // 会一起触发 `_ended()`，于是这里连收好几个 end，表现就是歌曲结尾连跳好几首。
              // 一次真正的播放结束不可能在 1s 内来两次，按时间窗口把重复的丢掉。
              const now = Date.now();
              if (now - this.lastEndAt < 1000) {
                console.warn(
                  `[audioService] 忽略重复的 end 事件（距上次 ${now - this.lastEndAt}ms）`
                );
                return;
              }
              this.lastEndAt = now;
              this.emit('end');
            });

            soundInstance.on('seek', () => {
              if (this.currentSound === soundInstance) {
                this.updateMediaSessionPositionState();
                this.emit('seek');
              }
            });

            this.attachMediaProbe(soundInstance);
          }
        } catch (error) {
          console.error('Error creating audio instance:', error);
          this.releaseOperationLock();
          reject(error);
        }
      };

      tryPlay();
    }).finally(() => {
      // 无论成功或失败都解除操作锁
      this.releaseOperationLock();
    });
  }

  /** 已挂过 DOM 监听的 <audio> —— howler 的节点是复用池，同一个节点不要重复挂 */
  private probedNodes = new WeakSet<HTMLMediaElement>();

  /**
   * 已经被某个 AudioContext 接管过、又因为那个上下文没了而变成哑巴的 <audio>。
   *
   * Chromium 里「元素被接管」是终身状态：这类元素再 createMediaElementSource 会抛
   * InvalidStateError（见 setupEQ 的 catch），而且它自己已经发不出声了。它们本身救不回来，
   * 唯一要做的是别让 howler 的复用池把它们发给下一首——池子是 LIFO，刚 unload 的元素就是
   * 下一个被 pop 的，不剔掉的话后面每一首都会撞上同一个错误。
   */
  private poisonedNodes = new WeakSet<HTMLMediaElement>();

  /**
   * 把已经变成哑巴的 <audio> 从 howler 的复用池里剔出去。
   * 在每次建新 Howl 之前调用：那时上一首的节点刚被 unload 回池子，正是要拦的时机。
   */
  private evictPoisonedNodes() {
    const pool = (Howler as any)._html5AudioPool as HTMLMediaElement[] | undefined;
    if (!Array.isArray(pool)) return;

    for (let i = pool.length - 1; i >= 0; i--) {
      if (this.poisonedNodes.has(pool[i])) {
        console.warn(
          '[audioService] 从复用池里剔除一个被音频上下文接管过的 <audio>，避免它拖住后面每一首'
        );
        pool.splice(i, 1);
      }
    }
  }

  /**
   * DOM 节点 → 当前拥有它的 Howl。
   *
   * 节点会被复用池换给下一首，所以判断事件归属必须查这张表，不能在闭包里捕获
   * Howl——闭包会随着节点被复用而指向上一首，误判成「外部事件」。
   */
  private probeOwners = new WeakMap<HTMLMediaElement, Howl>();

  /**
   * 探针：监听底层 <audio> 的 DOM 事件，一是留排障证据，二是纠正外部造成的播放状态。
   *
   * howler 只在它自己调 `pause()` / `play()` 时派发对应事件，DOM 层面被外部掐断或
   * 续上（Chromium 的音频焦点仲裁、系统打断）它一无所知。不管的话前端状态会停在
   * 「播放中」，通知栏进度条照常往前跑，而声音早就停了。
   *
   * 判断「这次是不是我们干的」以 howler 自己的 `_paused` 为准：howler 发起的那次
   * 必然已经把状态同步翻过去了，这里就不会再补一刀；只有状态对不上才说明是外部所为。
   *
   * 配合 NowPlayingService 侧移除原生焦点（见那边的注释）——焦点交给真正发声的
   * Chromium 管，打断与恢复如实反映在这些 DOM 事件上，再从这里同步回 store 和通知栏。
   */
  private attachMediaProbe(howl: Howl) {
    // html5 模式下 _node 是 <audio>；Web Audio 模式下是 GainNode，没有 DOM 事件可听
    const node = this.nodeOf(howl);
    if (!node) {
      console.log('audioService: 未取得 <audio> 节点，跳过 DOM 探针');
      return;
    }

    // 每次都刷新归属，即使监听已经挂过——节点可能刚被换给新的一首
    this.probeOwners.set(node, howl);
    if (this.probedNodes.has(node)) return;
    this.probedNodes.add(node);

    console.log('audioService: DOM 探针已挂载');

    /** 事件是不是来自当前正在播（或正要切过去）的那一首 */
    const isCurrent = () => {
      const owner = this.probeOwners.get(node);
      return owner === this.currentSound || owner === this.pendingSound;
    };

    const snapshot = (name: string) =>
      `[audio-dom] ${name} paused=${node.paused} t=${node.currentTime.toFixed(2)} ` +
      `readyState=${node.readyState} networkState=${node.networkState}`;

    (['playing', 'waiting', 'stalled', 'suspend', 'emptied', 'abort', 'ended'] as const).forEach(
      (name) => {
        node.addEventListener(name, () => console.log(snapshot(name)));
      }
    );

    // 每次换源都记下 URL，出问题时才能把失败的那一首和地址对上
    node.addEventListener('loadstart', () => {
      console.log(`[audio-dom] loadstart src=${node.src}`);
    });

    node.addEventListener('error', () => {
      const err = node.error;
      // code: 1=中止 2=网络 3=解码 4=格式/源不支持
      console.error(`[audio-dom] error code=${err?.code} message=${err?.message} src=${node.src}`);
    });

    // pause / play 单独处理：除了留证据，还要把外部造成的状态变化同步回去，
    // 走的路径和上面 howler 自己的监听器完全一致，保证两条来路状态一致。
    //
    // readyState=0 表示这个节点上已经没有媒体了——卸载/换源会把 src 抹掉，
    // 那种 pause 是回收过程的一部分，不是「正在播的这首歌被掐了」，别误判。
    const isLive = () => isCurrent() && node.readyState > 0;

    node.addEventListener('pause', () => {
      console.log(snapshot('pause'));
      if (!isLive()) return;
      const owner = this.probeOwners.get(node);
      if (owner?.playing()) {
        console.warn('[audio-dom] 音频被外部暂停（非 howler 发起），同步播放状态');
        this.updateMediaSessionState(false, owner);
        this.emit('pause');
      }
    });

    node.addEventListener('play', () => {
      console.log(snapshot('play'));
      if (!isLive()) return;
      const owner = this.probeOwners.get(node);
      if (owner && !owner.playing()) {
        console.warn('[audio-dom] 音频被外部恢复（非 howler 发起），同步播放状态');
        this.updateMediaSessionState(true, owner);
        this.emit('play');
      }
    });
  }

  getCurrentSound() {
    return this.currentSound;
  }

  getCurrentTrack() {
    return this.currentTrack;
  }

  stop() {
    // 强制重置操作锁并继续执行
    this.forceResetOperationLock();

    try {
      if (this.currentSound) {
        try {
          // 确保任何进行中的seek操作被取消
          if (this.seekLock && this.seekDebounceTimer) {
            clearTimeout(this.seekDebounceTimer);
            this.seekLock = false;
          }
          this.currentSound.stop();
          this.currentSound.unload();
        } catch (error) {
          console.error('停止音频失败:', error);
        }
        this.currentSound = null;
      }

      this.currentTrack = null;
      this.sessionPlayingReported = false;
      this.stopPlayStateWatchdog();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
      }

      // 这里必须保留上下文（keepContext=true），别关。
      // <audio> 元素一旦被某个 AudioContext 接管过，Chromium 就永久记住这层关系：同一个
      // 元素再 createMediaElementSource 一律抛 InvalidStateError，而且它当场变成哑巴
      // （paused 一直是 false、currentTime 冻住、永远不出声）。而 howler 的 <audio> 是从
      // 复用池里发的——刚 unload 的那个元素就是下一个 pop 拿到的那个。
      // 所以关一次上下文，等于把「这首歌的元素」变成哑巴，并且它会在池子里一首接一首地
      // 传下去：此后每次换歌都卡在 setupEQ 的 InvalidStateError 上，表现正是「切到了下一首
      // 但没有声音」。留着这个上下文几乎不占资源，代价远小于把播放链路废掉。
      // 注意：系统媒体会话的 stop（桌面端注册在 initMediaSession 里，任务栏/系统媒体控件
      // 那套会走到它）以及 Android 通知栏的停止，都会进到这里。
      void this.disposeEQ(true);
    } catch (error) {
      console.error('停止音频时发生错误:', error);
    }
  }

  setVolume(volume: number) {
    this.applyVolume(volume);
  }

  seek(time: number) {
    // 直接强制重置操作锁
    this.forceResetOperationLock();

    if (this.currentSound) {
      try {
        // 直接执行seek操作
        this.currentSound.seek(time);
        // 触发seek事件
        this.updateMediaSessionPositionState();
        this.emit('seek', time);
      } catch (error) {
        console.error('Seek操作失败:', error);
      }
    }
  }

  pause() {
    this.forceResetOperationLock();

    if (this.currentSound) {
      try {
        // 确保任何进行中的seek操作被取消
        if (this.seekLock && this.seekDebounceTimer) {
          clearTimeout(this.seekDebounceTimer);
          this.seekLock = false;
        }
        this.currentSound.pause();
      } catch (error) {
        console.error('暂停音频失败:', error);
      }
    }
  }

  clearAllListeners() {
    this.callbacks = {};
  }

  public getCurrentPreset(): string | null {
    return localStorage.getItem('currentPreset');
  }

  public setCurrentPreset(preset: string): void {
    localStorage.setItem('currentPreset', preset);
  }

  // ==================== 音频输出设备管理 ====================

  /**
   * 获取可用的音频输出设备列表
   */
  public async getAudioOutputDevices(): Promise<AudioOutputDevice[]> {
    try {
      // 先尝试获取一个临时音频流来触发权限授予
      // 确保 enumerateDevices 返回完整的设备信息（包括 label）
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // 即使失败也继续，可能已有权限
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

      return audioOutputs.map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Speaker ${index + 1}`,
        isDefault: device.deviceId === 'default' || device.deviceId === ''
      }));
    } catch (error) {
      console.error('枚举音频设备失败:', error);
      return [{ deviceId: 'default', label: 'Default', isDefault: true }];
    }
  }

  /**
   * 设置音频输出设备
   * 使用 AudioContext.setSinkId() 而不是 HTMLMediaElement.setSinkId()
   * 因为音频通过 MediaElementAudioSourceNode 进入 Web Audio 图后，
   * HTMLMediaElement.setSinkId() 不再生效
   */
  public async setAudioOutputDevice(deviceId: string): Promise<boolean> {
    try {
      if (this.context && typeof (this.context as any).setSinkId === 'function') {
        await (this.context as any).setSinkId(deviceId);
        this.currentSinkId = deviceId;
        localStorage.setItem('audioOutputDeviceId', deviceId);
        console.log('音频输出设备已切换:', deviceId);
        return true;
      } else {
        console.warn('AudioContext.setSinkId 不可用');
        return false;
      }
    } catch (error) {
      console.error('设置音频输出设备失败:', error);
      return false;
    }
  }

  /**
   * 获取当前输出设备ID
   */
  public getCurrentSinkId(): string {
    return this.currentSinkId;
  }

  /**
   * 恢复保存的音频输出设备设置
   */
  private async restoreSavedAudioDevice(): Promise<void> {
    const savedDeviceId = localStorage.getItem('audioOutputDeviceId');
    if (savedDeviceId && savedDeviceId !== 'default') {
      try {
        await this.setAudioOutputDevice(savedDeviceId);
      } catch (error) {
        console.warn('恢复音频输出设备失败，回退到默认设备:', error);
        localStorage.removeItem('audioOutputDeviceId');
        this.currentSinkId = 'default';
      }
    }
  }

  /**
   * 设置 AudioContext 状态监控
   * 监听上下文状态变化，自动恢复 suspended 状态
   */
  private setupContextStateMonitoring() {
    if (!this.context || this.contextStateMonitoringInitialized) return;

    this.context.addEventListener('statechange', async () => {
      console.log('AudioContext state changed:', this.context?.state);

      if (this.context?.state === 'suspended' && this.currentSound?.playing()) {
        console.log('AudioContext suspended while playing, attempting to resume...');
        try {
          await this.context.resume();
          console.log('AudioContext resumed successfully');
        } catch (e) {
          console.error('Failed to resume AudioContext:', e);
          this.emit('audio_error', { type: 'context_suspended', error: e });
        }
      } else if (this.context?.state === 'closed') {
        console.warn('AudioContext was closed unexpectedly');
        this.emit('audio_error', { type: 'context_closed' });
      }
    });

    this.contextStateMonitoringInitialized = true;
    console.log('AudioContext state monitoring initialized');
  }

  /**
   * 验证音频图是否正确连接
   * 用于检测音频播放前的图状态
   */
  // 检查音频图是否连接（调试用，保留供 EQ 诊断）
  // @ts-ignore 保留供调试使用
  private isAudioGraphConnected(): boolean {
    if (!this.context || !this.gainNode || !this.source) {
      return false;
    }

    try {
      // 检查 context 是否运行
      if (this.context.state !== 'running') {
        console.warn('AudioContext is not running, state:', this.context.state);
        return false;
      }

      // Web Audio API 不直接暴露连接状态，
      // 但我们可以验证节点存在且 context 有效
      return true;
    } catch (e) {
      console.error('Error checking audio graph:', e);
      return false;
    }
  }

  public setPlaybackRate(rate: number) {
    if (!this.currentSound) return;
    this.playbackRate = rate;

    // Howler 的 rate() 在 html5 模式下不生效
    this.currentSound.rate(rate);

    // 取出底层 HTMLAudioElement，改原生 playbackRate
    const sounds = (this.currentSound as any)._sounds as any[];
    sounds.forEach(({ _node }) => {
      if (_node instanceof HTMLAudioElement) {
        _node.playbackRate = rate;
      }
    });

    // 同步给 Media Session UI
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
      navigator.mediaSession.setPositionState({
        duration: this.currentSound.duration(),
        playbackRate: rate,
        position: this.getCurrentPosition()
      });
    }
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  // 新的音量调节方法
  private applyVolume(volume: number) {
    // 确保值在0到1之间
    const normalizedVolume = Math.max(0, Math.min(1, volume));

    // 使用线性缩放音量
    const linearVolume = normalizedVolume;

    // 将音量应用到所有相关节点
    if (this.gainNode) {
      // 立即设置音量
      this.gainNode.gain.cancelScheduledValues(this.context!.currentTime);
      this.gainNode.gain.setValueAtTime(linearVolume, this.context!.currentTime);
    } else {
      this.currentSound?.volume(linearVolume);
    }

    // 保存值
    localStorage.setItem('volume', linearVolume.toString());

    console.log('Volume applied (linear):', linearVolume);
  }

  // 添加方法检查当前音频是否在加载状态
  isLoading(): boolean {
    if (!this.currentSound) return false;

    // 检查Howl对象的内部状态
    // 如果状态为1表示已经加载但未完成，状态为2表示正在加载
    const state = (this.currentSound as any)._state;
    // 如果操作锁激活也认为是加载状态
    return this.operationLock || state === 'loading' || state === 1;
  }

  // 检查音频是否真正在播放
  isActuallyPlaying(): boolean {
    if (!this.currentSound) return false;

    try {
      // 核心判断：Howler API 是否报告正在播放 + 音频上下文是否正常
      // 注意：不再检查 isAudioGraphConnected()，因为 EQ 重建期间
      // source/gainNode 会暂时为 null，导致误判为未播放
      const isPlaying = this.currentSound.playing();
      const isLoading = this.isLoading();
      const contextRunning = Howler.ctx && Howler.ctx.state === 'running';

      return isPlaying && !isLoading && contextRunning;
    } catch (error) {
      console.error('检查播放状态出错:', error);
      return false;
    }
  }
}

export const audioService = new AudioService();
