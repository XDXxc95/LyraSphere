import { Capacitor } from '@capacitor/core';
import type { Router } from 'vue-router';

import { usePlayerStore } from '@/store/modules/player';

/**
 * 主页面。这里是「再退一层就退出 app」的分界线。
 */
const HOME_PATH = '/';

declare global {
  interface Window {
    __lyraHandleBack?: () => boolean;
  }
}

/**
 * Android 返回键（物理键 / 全面屏手势）。
 *
 * Capacitor 的 {@code BridgeActivity} 本身不处理返回键，App 插件也没装，所以按返回走的是
 * Activity 的默认行为——直接 finish，回到桌面。可全屏播放器、歌单页这些地方明显「还能再退
 * 一层」，用户按返回期待的是退回去，结果整个 app 没了。
 *
 * 判断放在前端：原生按下时调 {@code window.__lyraHandleBack()}，由这里决定这次返回能不能自己
 * 消化。返回 true 表示已经处理掉（关了浮层 / 退回主页面），原生什么都不用做；返回 false 表示
 * 管不了（本来就停在主页面），交回原生走默认的退出。只有路由和 store 知道现在还能不能退。
 */
export const initAndroidBack = (router: Router) => {
  if (!Capacitor.isNativePlatform()) return;

  window.__lyraHandleBack = () => handleBack(router);
};

const handleBack = (router: Router): boolean => {
  // 浮层压在最上面，先关浮层再谈退页面
  if (closeTopOverlay()) return true;

  if (router.currentRoute.value.path !== HOME_PATH) {
    console.log('[androidBack] 不在主页面，退回主页面');
    router.push(HOME_PATH);
    return true;
  }

  console.log('[androidBack] 已在主页面，交回原生退出');
  return false;
};

/**
 * 关掉盖在最上面的那个全屏浮层。这类浮层不是路由，「退一层」只能靠各自的开关状态。
 */
const closeTopOverlay = (): boolean => {
  const playerStore = usePlayerStore();

  // 播放列表抽屉盖在全屏播放器上面，所以先关它
  if (playerStore.playListDrawerVisible) {
    console.log('[androidBack] 关闭播放列表抽屉');
    playerStore.setPlayListDrawerVisible(false);
    return true;
  }

  if (playerStore.musicFull) {
    console.log('[androidBack] 收起全屏播放器');
    playerStore.setMusicFull(false);
    return true;
  }

  return false;
};
