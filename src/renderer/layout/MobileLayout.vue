<template>
  <div id="layout-main" class="mobile-layout mobile" :class="{ 'has-safe-area': isPhone }">
    <!-- 顶部头部 -->
    <mobile-header />

    <!-- 主内容区域 -->
    <div
      class="mobile-content"
      :class="{ 'has-bottom-menu': shouldShowBottomMenu, 'has-player': isPlay }"
    >
      <router-view v-slot="{ Component }" class="mobile-page">
        <keep-alive :include="keepAliveInclude">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </div>

    <!-- 底部播放条 -->
    <mobile-play-bar v-if="isPlay" />

    <!-- 底部导航菜单 -->
    <div v-if="shouldShowBottomMenu" class="mobile-bottom-menu">
      <app-menu class="mobile-menu" :menus="menuStore.menus" />
    </div>
    <!-- 其他弹窗/抽屉 -->
    <playlist-drawer v-model="showPlaylistDrawer" :song-id="currentSongId" />
    <playing-list-drawer />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, provide, ref } from 'vue';

import homeRouter from '@/router/home';
import otherRouter from '@/router/other';
import { useMenuStore } from '@/store/modules/menu';
import { usePlayerStore } from '@/store/modules/player';

import AppMenu from './components/AppMenu.vue';
import MobileHeader from './components/MobileHeader.vue';
const MobilePlayBar = defineAsyncComponent(() => import('@/components/player/MobilePlayBar.vue'));
const PlayingListDrawer = defineAsyncComponent(
  () => import('@/components/player/PlayingListDrawer.vue')
);
const PlaylistDrawer = defineAsyncComponent(() => import('@/components/common/PlaylistDrawer.vue'));

const props = defineProps<{
  isPhone: boolean;
}>();

const playerStore = usePlayerStore();
const menuStore = useMenuStore();

// 提供是否有安全区域
provide('hasSafeArea', props.isPhone);

// 是否有播放的歌曲
const isPlay = computed(() => playerStore.playMusic && playerStore.playMusic.id);

// 底部功能栏常驻：除全屏播放器外，所有页面都显示
const shouldShowBottomMenu = computed(() => !playerStore.musicFull);

// 提供给 MobilePlayBar 使用，用于调整播放栏位置
provide('shouldShowMobileMenu', shouldShowBottomMenu);

// Keep-alive 配置
const keepAliveInclude = computed(() => {
  const allRoutes = [...homeRouter, ...otherRouter];
  return allRoutes
    .filter((item) => item.meta?.keepAlive)
    .map((item) =>
      typeof item.name === 'string' ? item.name.charAt(0).toUpperCase() + item.name.slice(1) : ''
    )
    .filter(Boolean);
});

// 歌单抽屉
const showPlaylistDrawer = ref(false);
const currentSongId = ref<number | undefined>();

// 提供打开歌单抽屉的方法
const openPlaylistDrawer = (songId: number, isOpen: boolean = true) => {
  currentSongId.value = songId;
  showPlaylistDrawer.value = isOpen;
  playerStore.setMusicFull(false);
  playerStore.setPlayListDrawerVisible(!isOpen);
};

provide('openPlaylistDrawer', openPlaylistDrawer);
</script>

<style lang="scss" scoped>
.mobile-layout {
  @apply w-screen h-screen flex flex-col;
  @apply bg-light dark:bg-black;
  @apply overflow-hidden;
  position: relative;
}

.mobile-content {
  @apply flex-1 overflow-auto;

  // 底部既没有菜单也没有播放栏时，内容直接贴到屏幕底边，需要避开全面屏手势条
  &:not(.has-bottom-menu):not(.has-player) {
    padding-bottom: var(--safe-area-inset-bottom);
  }
}

.mobile-page {
  @apply h-full;
}

// 底部菜单固定在底部
.mobile-bottom-menu {
  @apply bg-light dark:bg-black;
  @apply border-t border-gray-200 dark:border-gray-800;
  // 手势条区域留白，避免菜单项被系统手势条压住
  padding-bottom: var(--safe-area-inset-bottom);
}

.mobile-menu {
  @apply w-full;
}
</style>
