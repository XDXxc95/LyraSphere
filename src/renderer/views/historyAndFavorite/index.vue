<template>
  <div
    class="history-favorite-page flex h-full pb-4 page-padding bg-white dark:bg-black"
    :class="isMobile ? 'flex-col gap-3 pt-3' : 'gap-6 pt-6'"
  >
    <!-- 手机宽度塞不下左右双栏，改成顶部胶囊二选一。
         以前这里直接是 <favorite v-if="!isMobile">，而 favorite 全项目只有这一处引用，
         等于「我的收藏」在移动端完全没有入口——收藏历史页只剩播放记录。 -->
    <div v-if="isMobile" class="flex-shrink-0 flex justify-center">
      <div class="bg-gray-100 dark:bg-neutral-800 p-1 rounded-full inline-flex h-9 items-center">
        <div
          v-for="tab in mobileTabs"
          :key="tab.key"
          class="px-4 h-7 rounded-full text-xs font-medium cursor-pointer transition-all duration-300 flex items-center justify-center whitespace-nowrap"
          :class="
            mobileTab === tab.key
              ? 'bg-white dark:bg-neutral-700 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400'
          "
          @click="mobileTab = tab.key"
        >
          {{ t(tab.label) }}
        </div>
      </div>
    </div>

    <favorite v-if="!isMobile || mobileTab === 'favorite'" class="flex-item" />
    <history-list v-if="!isMobile || mobileTab === 'history'" class="flex-item" />
  </div>
</template>

<script setup lang="ts">
defineOptions({
  name: 'History'
});

import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { isMobile } from '@/utils';
import Favorite from '@/views/favorite/index.vue';
import HistoryList from '@/views/history/index.vue';

const { t } = useI18n();

type MobileTab = 'favorite' | 'history';

/** 默认落在「我的收藏」：桌面端双栏也是收藏在左，顺序一致 */
const mobileTab = ref<MobileTab>('favorite');

const mobileTabs = computed<{ key: MobileTab; label: string }[]>(() => [
  { key: 'favorite', label: 'favorite.title' },
  { key: 'history', label: 'history.title' }
]);
</script>

<style scoped>
.flex-item {
  /* min-h-0：移动端父容器是 flex-col，不给这个的话子元素会被撑出容器、滚不动 */
  @apply flex-1 min-h-0 bg-gray-50 dark:bg-neutral-900/50 rounded-3xl overflow-hidden border border-gray-100 dark:border-neutral-800 transition-all duration-300;
}
</style>
