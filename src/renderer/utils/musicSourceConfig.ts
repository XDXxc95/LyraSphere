import { computed } from 'vue';

import { useSettingsStore } from '@/store';
import type { Platform } from '@/types/music';
import { isElectron } from '@/utils';

// ==================== 类型定义 ====================

export type MusicSourceGroup = 'unblock' | 'extended' | 'plugin';

export type MusicSourceMeta = {
  key: Platform;
  icon: string;
  color: string;
  group: MusicSourceGroup;
};

export type MusicSourceInfo = MusicSourceMeta & {
  available: boolean;
  configHint?: string;
  /**
   * 当前平台能不能用它。
   *
   * 跟 `available` 是两回事：`available` 说的是「配置好了没」（lxMusic / custom 未配置时
   * 为 false，点了会提示并跳到对应 tab），`supported` 说的是「这个平台有没有这条链路」。
   * unblock 那一组挂在主进程的解锁服务上，Web / Android 没有主进程，选了也不会生效。
   */
  supported: boolean;
};

// ==================== 静态注册表 ====================

export const MUSIC_SOURCE_REGISTRY: MusicSourceMeta[] = [
  // 内置解锁音源 (UnblockMusicStrategy)
  { key: 'migu', icon: 'ri-music-2-fill', color: '#ff6600', group: 'unblock' },
  { key: 'kugou', icon: 'ri-music-fill', color: '#2979ff', group: 'unblock' },
  { key: 'kuwo', icon: 'ri-music-fill', color: '#ff8c00', group: 'unblock' },
  { key: 'pyncmd', icon: 'ri-netease-cloud-music-fill', color: '#ec4141', group: 'unblock' },
  // 扩展音源 (GDMusicStrategy)
  { key: 'gdmusic', icon: 'ri-google-fill', color: '#4285f4', group: 'extended' },
  // 插件音源 (需要用户配置)
  { key: 'lxMusic', icon: 'ri-leaf-fill', color: '#22c55e', group: 'plugin' },
  { key: 'custom', icon: 'ri-plug-fill', color: '#8b5cf6', group: 'plugin' }
];

// ==================== Composable ====================

export const useMusicSources = () => {
  const settingsStore = useSettingsStore();

  const allSources = computed<MusicSourceInfo[]>(() => {
    return MUSIC_SOURCE_REGISTRY.map((source) => {
      let available = true;
      let configHint: string | undefined;

      // 内置解锁音源只存在于桌面端（见 musicParser.ts 里 UnblockMusicStrategy.canHandle）
      const supported = source.group !== 'unblock' || isElectron;
      if (!supported) {
        configHint = 'settings.playback.desktopOnly';
      } else if (source.key === 'lxMusic') {
        available =
          (settingsStore.setData.lxMusicScripts?.length ?? 0) > 0 &&
          Boolean(settingsStore.setData.activeLxMusicApiId);
        if (!available) configHint = 'settings.playback.lxMusic.scripts.notConfigured';
      } else if (source.key === 'custom') {
        available = Boolean(settingsStore.setData.customApiPlugin);
        if (!available) configHint = 'settings.playback.customApi.notImported';
      }

      return { ...source, available, configHint, supported };
    });
  });

  return { allSources };
};
