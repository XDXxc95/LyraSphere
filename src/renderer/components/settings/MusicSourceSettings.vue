<template>
  <responsive-modal
    v-model="visible"
    :title="t('settings.playback.musicSources')"
    @close="handleCancel"
  >
    <div class="flex flex-col h-full">
      <!-- Tabs Header -->
      <div class="flex p-0.5 mb-3 bg-gray-100 dark:bg-white/5 rounded-lg shrink-0">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="flex-1 py-1 text-xs font-medium rounded-md transition-all duration-200"
          :class="[
            activeTab === tab.key
              ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          ]"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab Content -->
      <!-- 手机上这个弹窗是底部抽屉（见 ResponsiveModal），固定 400px 加上 tab 和 footer
           在小屏上会顶出可滚动区，所以再压一道视口高度 -->
      <div class="h-[400px] max-h-[55vh] relative shrink-0">
        <Transition name="fade" mode="out-in">
          <div :key="activeTab" class="h-full overflow-y-auto overscroll-contain">
            <!-- Sources Tab -->
            <div v-if="activeTab === 'sources'" class="space-y-3 pb-2">
              <p class="text-xs text-gray-500 dark:text-gray-400 px-1">
                {{ t('settings.playback.musicSourcesDesc') }}
              </p>

              <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
                <div
                  v-for="source in allSources"
                  :key="source.key"
                  class="group relative flex items-center p-2.5 rounded-xl border transition-all duration-200 cursor-pointer"
                  :class="[
                    isSourceSelected(source.key)
                      ? 'bg-emerald-50/50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20'
                      : 'bg-white dark:bg-white/5 border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/10',
                    { 'opacity-60 cursor-not-allowed': !source.available || !source.supported }
                  ]"
                  @click="toggleSource(source.key)"
                >
                  <div
                    class="flex items-center justify-center w-8 h-8 rounded-full mr-2.5 transition-colors shrink-0"
                    :style="{
                      backgroundColor: isSourceSelected(source.key) ? source.color : 'transparent',
                      color: isSourceSelected(source.key) ? '#fff' : source.color
                    }"
                    :class="{ 'bg-gray-100 dark:bg-white/10': !isSourceSelected(source.key) }"
                  >
                    <i :class="source.icon" class="text-base"></i>
                  </div>

                  <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between">
                      <span class="font-semibold text-gray-900 dark:text-white text-sm truncate">{{
                        source.key
                      }}</span>
                      <div
                        class="w-4 h-4 rounded-full border flex items-center justify-center transition-colors shrink-0 ml-1"
                        :class="[
                          isSourceSelected(source.key)
                            ? 'bg-emerald-500 border-emerald-500'
                            : 'border-gray-300 dark:border-gray-600'
                        ]"
                      >
                        <i
                          v-if="isSourceSelected(source.key)"
                          class="ri-check-line text-white text-xs scale-75"
                        ></i>
                      </div>
                    </div>
                    <!-- 平台不支持（如手机端的 migu/kugou）：置灰并说明原因，
                         否则用户点了没反应会以为坏了 -->
                    <p
                      v-if="!source.supported && source.configHint"
                      class="text-[10px] text-gray-500 mt-0.5 truncate"
                    >
                      {{ t(source.configHint) }}
                    </p>
                    <!-- lxMusic 子描述 -->
                    <p
                      v-else-if="source.key === 'lxMusic'"
                      class="text-[10px] text-gray-500 mt-0.5 truncate"
                    >
                      {{
                        activeLxApiId && lxMusicScriptInfo
                          ? lxMusicScriptInfo.name
                          : t('settings.playback.lxMusic.scripts.notConfigured')
                      }}
                    </p>
                    <!-- custom 子描述 -->
                    <p
                      v-else-if="source.key === 'custom'"
                      class="text-[10px] text-gray-500 mt-0.5 truncate"
                    >
                      {{
                        settingsStore.setData.customApiPlugin
                          ? t('settings.playback.customApi.status.imported')
                          : t('settings.playback.customApi.status.notImported')
                      }}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <!-- LX Music Management Tab -->
            <div v-else-if="activeTab === 'lxMusic'" class="space-y-3 pb-2">
              <div class="flex justify-between items-center mb-1">
                <h3 class="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {{ t('settings.playback.lxMusic.scripts.title') }}
                </h3>
                <!-- 本地导入走的是主进程的文件选择对话框（window.api.importLxMusicScript），
                     Web / Android 上没有 window.api。下面那个 URL 导入是纯 fetch，两端都能用 -->
                <button
                  v-if="isElectron"
                  @click="importLxMusicScript"
                  class="flex items-center gap-1 px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  <i class="ri-upload-line"></i>
                  {{ t('settings.playback.lxMusic.scripts.importLocal') }}
                </button>
              </div>

              <!-- Script List -->
              <div v-if="lxMusicApis.length > 0" class="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div
                  v-for="api in lxMusicApis"
                  :key="api.id"
                  class="flex items-center p-2.5 rounded-xl border transition-all duration-200"
                  :class="[
                    activeLxApiId === api.id
                      ? 'bg-emerald-50/50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20'
                      : 'bg-white dark:bg-white/5 border-gray-100 dark:border-white/5'
                  ]"
                >
                  <div class="relative flex items-center justify-center w-4 h-4 mr-3">
                    <input
                      type="radio"
                      :checked="activeLxApiId === api.id"
                      class="peer appearance-none w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600 checked:border-emerald-500 checked:bg-emerald-500 transition-colors cursor-pointer"
                      @change="setActiveLxApi(api.id)"
                    />
                    <i
                      class="ri-check-line absolute text-white text-[10px] pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity"
                    ></i>
                  </div>

                  <div class="flex-1 min-w-0 mr-2">
                    <div class="flex items-center gap-2">
                      <span
                        v-if="editingScriptId !== api.id"
                        class="font-medium text-sm text-gray-900 dark:text-white truncate"
                      >
                        {{ api.name }}
                      </span>
                      <input
                        v-else
                        v-model="editingName"
                        ref="renameInputRef"
                        class="w-full px-2 py-0.5 text-sm bg-white dark:bg-black/20 border border-emerald-500 rounded focus:outline-none"
                        @blur="saveScriptName(api.id)"
                        @keyup.enter="saveScriptName(api.id)"
                      />

                      <button
                        v-if="editingScriptId !== api.id"
                        class="text-gray-400 hover:text-emerald-500 transition-colors"
                        @click="startRenaming(api)"
                      >
                        <i class="ri-edit-line text-sm"></i>
                      </button>
                    </div>
                    <div class="flex items-center gap-2 mt-0.5">
                      <span
                        v-if="api.info.version"
                        class="text-[10px] text-gray-500 bg-gray-100 dark:bg-white/10 px-1.5 py-0.5 rounded"
                      >
                        v{{ api.info.version }}
                      </span>
                    </div>
                  </div>

                  <button
                    class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                    @click="removeLxApi(api.id)"
                  >
                    <i class="ri-delete-bin-line text-sm"></i>
                  </button>
                </div>
              </div>

              <div
                v-else
                class="py-6 text-center text-xs text-gray-400 bg-gray-50 dark:bg-white/5 rounded-xl border border-dashed border-gray-200 dark:border-white/10"
              >
                <p>{{ t('settings.playback.lxMusic.scripts.empty') }}</p>
              </div>

              <!-- URL Import -->
              <div class="mt-4 pt-4 border-t border-gray-100 dark:border-white/5">
                <h4 class="text-xs font-medium mb-2 text-gray-900 dark:text-white">
                  {{ t('settings.playback.lxMusic.scripts.importOnline') }}
                </h4>
                <div class="flex gap-2">
                  <input
                    v-model="lxScriptUrl"
                    :placeholder="t('settings.playback.lxMusic.scripts.urlPlaceholder')"
                    class="flex-1 px-3 py-1.5 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl text-xs focus:outline-none focus:border-emerald-500 transition-colors"
                    :disabled="isImportingFromUrl"
                  />
                  <button
                    @click="importLxMusicScriptFromUrl"
                    class="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-xl transition-colors flex items-center gap-1"
                    :disabled="!lxScriptUrl.trim() || isImportingFromUrl"
                  >
                    <i v-if="isImportingFromUrl" class="ri-loader-4-line animate-spin"></i>
                    <i v-else class="ri-download-line"></i>
                    {{ t('settings.playback.lxMusic.scripts.importBtn') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Custom API Tab -->
            <div v-else-if="activeTab === 'customApi'" class="space-y-3 pb-2">
              <!-- 当前生效的音源。放在最上面，改完立刻能看到结果 -->
              <div
                v-if="settingsStore.setData.customApiPluginName"
                class="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 rounded-xl text-xs"
              >
                <i class="ri-check-circle-fill shrink-0"></i>
                <span class="truncate"
                  >{{ t('settings.playback.customApi.currentSource') }}:
                  <b>{{ settingsStore.setData.customApiPluginName }}</b></span
                >
              </div>

              <div
                v-else
                class="px-3 py-2 text-xs text-gray-400 bg-gray-50 dark:bg-white/5 rounded-xl"
              >
                {{ t('settings.playback.customApi.notImported') }}
              </div>

              <!-- 桌面端：从本地挑一个 JSON 配置文件 -->
              <template v-if="isElectron">
                <div class="flex flex-col items-center pt-2 text-center">
                  <div
                    class="w-12 h-12 bg-violet-100 dark:bg-violet-500/20 text-violet-500 rounded-xl flex items-center justify-center mb-3"
                  >
                    <i class="ri-plug-fill text-2xl"></i>
                  </div>
                  <h3 class="text-base font-semibold text-gray-900 dark:text-white mb-1">
                    {{ t('settings.playback.customApi.sectionTitle') }}
                  </h3>
                  <p class="text-gray-500 dark:text-gray-400 text-xs mb-4 max-w-xs">
                    {{ t('settings.playback.lxMusic.scripts.importHint') }}
                  </p>
                </div>

                <button
                  @click="importPlugin"
                  class="w-full py-2 bg-violet-500 hover:bg-violet-600 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20"
                >
                  <i class="ri-upload-line"></i>
                  {{ t('settings.playback.customApi.importConfig') }}
                </button>
              </template>

              <!-- Web / Android：没有主进程也就没有 window.api，文件选择框调不出来。
                   改成填一个远程地址，或者直接把 JSON 粘进来 —— 手机上后者最实在 -->
              <template v-else>
                <div>
                  <h4 class="text-xs font-medium mb-2 text-gray-900 dark:text-white">
                    {{ t('settings.playback.customApi.importFromUrl') }}
                  </h4>
                  <div class="flex gap-2">
                    <input
                      v-model="customApiUrl"
                      :placeholder="t('settings.playback.customApi.urlPlaceholder')"
                      class="flex-1 min-w-0 px-3 py-1.5 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl text-xs focus:outline-none focus:border-violet-500 transition-colors"
                      :disabled="isImportingCustomApi"
                    />
                    <button
                      @click="importCustomApiFromUrl"
                      class="px-3 py-1.5 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-xl transition-colors flex items-center gap-1 shrink-0"
                      :disabled="!customApiUrl.trim() || isImportingCustomApi"
                    >
                      <i v-if="isImportingCustomApi" class="ri-loader-4-line animate-spin"></i>
                      <i v-else class="ri-download-line"></i>
                      {{ t('settings.playback.lxMusic.scripts.importBtn') }}
                    </button>
                  </div>
                </div>

                <div class="pt-3 border-t border-gray-100 dark:border-white/5">
                  <h4 class="text-xs font-medium mb-2 text-gray-900 dark:text-white">
                    {{ t('settings.playback.customApi.pasteJson') }}
                  </h4>
                  <textarea
                    v-model="customApiJson"
                    rows="7"
                    spellcheck="false"
                    :placeholder="t('settings.playback.customApi.jsonPlaceholder')"
                    class="w-full px-3 py-2 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl text-xs font-mono focus:outline-none focus:border-violet-500 transition-colors resize-none"
                  ></textarea>
                  <div class="flex justify-end gap-2 mt-2">
                    <button
                      class="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
                      @click="resetCustomApiPreset"
                    >
                      {{ t('settings.playback.customApi.resetPreset') }}
                    </button>
                    <button
                      class="px-3 py-1.5 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-xl transition-colors"
                      :disabled="!customApiJson.trim()"
                      @click="applyCustomApiJson"
                    >
                      {{ t('settings.playback.customApi.apply') }}
                    </button>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <!-- Footer Actions -->
    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          class="px-4 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
          @click="handleCancel"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          class="px-4 py-2 text-xs font-medium text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg shadow-lg shadow-emerald-500/20 transition-all active:scale-95"
          @click="handleConfirm"
        >
          {{ t('common.confirm') }}
        </button>
      </div>
    </template>
  </responsive-modal>
</template>

<script setup lang="ts">
import { useMessage } from 'naive-ui';
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import ResponsiveModal from '@/components/common/ResponsiveModal.vue';
import { PRESET_CUSTOM_API_PLUGIN } from '@/const/music-source-preset';
import {
  initLxMusicRunner,
  parseScriptInfo,
  setLxMusicRunner
} from '@/services/LxMusicSourceRunner';
import { useSettingsStore } from '@/store';
import type { LxMusicScriptConfig, LxScriptInfo, LxSourceKey } from '@/types/lxMusic';
import { type Platform } from '@/types/music';
import { isElectron } from '@/utils';
import { useMusicSources } from '@/utils/musicSourceConfig';

// ==================== Props & Emits ====================
const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  sources: {
    type: Array as () => Platform[],
    default: () => ['migu', 'kugou', 'kuwo', 'pyncmd'] as Platform[]
  }
});

const emit = defineEmits(['update:show', 'update:sources']);

// ==================== 状态管理 ====================
const { t } = useI18n();
const settingsStore = useSettingsStore();
const message = useMessage();
const visible = ref(props.show);
const selectedSources = ref<Platform[]>([...props.sources]);
const activeTab = ref('sources');
const { allSources } = useMusicSources();

const tabs = computed(() => [
  { key: 'sources', label: t('settings.playback.lxMusic.tabs.sources') },
  { key: 'lxMusic', label: t('settings.playback.lxMusic.tabs.lxMusic') },
  { key: 'customApi', label: t('settings.playback.lxMusic.tabs.customApi') }
]);

// 落雪音源列表（从 store 中的脚本解析）
const lxMusicApis = computed<LxMusicScriptConfig[]>(() => {
  const scripts = settingsStore.setData.lxMusicScripts || [];
  return scripts;
});

// 当前激活的音源 ID
const activeLxApiId = computed<string | null>({
  get: () => settingsStore.setData.activeLxMusicApiId || null,
  set: (id: string | null) => {
    settingsStore.setSetData({ activeLxMusicApiId: id });
  }
});

// 落雪音源脚本信息（保持向后兼容）
const lxMusicScriptInfo = computed<LxScriptInfo | null>(() => {
  const activeId = activeLxApiId.value;
  if (!activeId) {
    return null;
  }
  const activeApi = lxMusicApis.value.find((api: LxMusicScriptConfig) => api.id === activeId);
  return activeApi?.info || null;
});

// URL 导入相关状态
const lxScriptUrl = ref('');
const isImportingFromUrl = ref(false);

// 自定义音源相关状态（仅非 Electron 用得上：桌面端走文件选择框）
const customApiUrl = ref('');
const isImportingCustomApi = ref(false);
const customApiJson = ref('');

// 重命名相关状态
const editingScriptId = ref<string | null>(null);
const editingName = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

// ==================== 计算属性 ====================
const isSourceSelected = (sourceKey: string): boolean => {
  return selectedSources.value.includes(sourceKey as Platform);
};

/**
 * 摘掉当前平台跑不了的音源。
 *
 * 存量配置里带着 migu/kugou 这些（set.json 的默认值），在手机上它们不会生效，
 * 留着只会在设置页的「已选音源」那行里显示成一串没用的名字。
 */
const dropUnsupportedSources = (sources: Platform[]): Platform[] =>
  sources.filter(
    (key) => allSources.value.find((source) => source.key === key)?.supported !== false
  );

// ==================== 方法 ====================
/**
 * 切换音源选择状态
 */
const toggleSource = (sourceKey: string) => {
  // 当前平台没有这条链路（手机端的 migu/kugou/kuwo/pyncmd）：置灰只是视觉，
  // 不挡住的话点下去照样会改 selectedSources，用户以为选上了其实没生效
  const meta = allSources.value.find((source) => source.key === sourceKey);
  if (meta && !meta.supported) return;

  // 检查是否是自定义API且未导入
  if (sourceKey === 'custom' && !settingsStore.setData.customApiPlugin) {
    message.warning(t('settings.playback.customApi.enableHint'));
    activeTab.value = 'customApi';
    return;
  }

  // 检查是否是落雪音源且未配置
  if (sourceKey === 'lxMusic') {
    if (lxMusicApis.value.length === 0) {
      message.warning(t('settings.playback.lxMusic.scripts.noScriptWarning'));
      activeTab.value = 'lxMusic';
      return;
    }
    if (!activeLxApiId.value) {
      message.warning(t('settings.playback.lxMusic.scripts.noSelectionWarning'));
      activeTab.value = 'lxMusic';
      return;
    }
  }

  const index = selectedSources.value.indexOf(sourceKey as Platform);
  if (index > -1) {
    // 至少保留一个音源
    if (selectedSources.value.length <= 1) {
      message.warning(t('settings.playback.musicSourcesWarning'));
      return;
    }
    selectedSources.value.splice(index, 1);
  } else {
    selectedSources.value.push(sourceKey as Platform);
  }
};

/**
 * 校验一段文本是不是能用的自定义音源配置。
 *
 * 必填项跟 parseFromCustomApi 里的判定保持一致（apiUrl / params / responseUrlPath），
 * 那边才是真正消费它的地方，这里只是提前把错误拦下来给个提示。
 */
const parseCustomApiPlugin = (raw: string): Record<string, any> | null => {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.apiUrl || !parsed.params || !parsed.responseUrlPath) return null;
    return parsed;
  } catch {
    return null;
  }
};

/**
 * 应用一份自定义音源配置（粘贴进来的、或从 URL 下下来的）。
 * @param raw 配置文本
 * @param fallbackName 配置里没写 name 时用它顶替
 */
const applyCustomApiPlugin = (raw: string, fallbackName: string): boolean => {
  const plugin = parseCustomApiPlugin(raw);
  if (!plugin) {
    message.error(t('settings.playback.customApi.invalidJson'));
    return false;
  }

  const name = plugin.name || fallbackName;
  // 存归一化后的 JSON，用户回到这个 tab 时看到的是排好版的，而不是他粘进来的原始文本
  settingsStore.setCustomApiPlugin({ name, content: JSON.stringify(plugin, null, 2) });

  // 配好了就顺手勾上，省得用户还得回音源选择 tab 再点一次
  if (!selectedSources.value.includes('custom')) {
    selectedSources.value.push('custom');
  }

  message.success(t('settings.playback.customApi.importSuccess', { name }));
  return true;
};

/** 从 URL 拉一份自定义音源配置 */
const importCustomApiFromUrl = async () => {
  const url = customApiUrl.value.trim();
  if (!url) return;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    message.error(t('settings.playback.lxMusic.scripts.invalidUrl'));
    return;
  }

  isImportingCustomApi.value = true;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    if (applyCustomApiPlugin(await response.text(), host)) {
      customApiUrl.value = '';
    }
  } catch (error: any) {
    console.error('[MusicSourceSettings] 从 URL 导入自定义音源失败:', error);
    message.error(
      `${t('settings.playback.customApi.importFromUrl')} ${t('common.error')}：${error.message}`
    );
  } finally {
    isImportingCustomApi.value = false;
  }
};

/** 应用粘贴框里的 JSON */
const applyCustomApiJson = () => {
  applyCustomApiPlugin(customApiJson.value, 'Custom API');
};

/** 恢复成内置的预置音源 */
const resetCustomApiPreset = () => {
  applyCustomApiPlugin(JSON.stringify(PRESET_CUSTOM_API_PLUGIN), PRESET_CUSTOM_API_PLUGIN.name);
};

/**
 * 导入自定义API插件
 */
const importPlugin = async () => {
  try {
    const result = await window.api.importCustomApiPlugin();
    if (result && result.name && result.content) {
      settingsStore.setCustomApiPlugin(result);
      message.success(t('settings.playback.customApi.importSuccess', { name: result.name }));

      // 导入成功后自动勾选
      if (!selectedSources.value.includes('custom')) {
        selectedSources.value.push('custom');
      }
    }
  } catch (error: any) {
    message.error(t('settings.playback.customApi.importFailed', { message: error.message }));
  }
};

/**
 * 导入落雪音源脚本
 */
const importLxMusicScript = async () => {
  try {
    const result = await window.api.importLxMusicScript();
    if (result && result.content) {
      await addLxMusicScript(result.content);
    }
  } catch (error: any) {
    console.error('导入落雪音源脚本失败:', error);
    message.error(`${t('common.error')}：${error.message}`);
  }
};

/**
 * 添加落雪音源脚本到列表
 */
const addLxMusicScript = async (scriptContent: string) => {
  // 解析脚本信息
  const scriptInfo = parseScriptInfo(scriptContent);

  // 尝试初始化执行器以验证脚本
  try {
    const runner = await initLxMusicRunner(scriptContent);
    const sources = runner.getSources();
    const sourceKeys = Object.keys(sources) as LxSourceKey[];

    // 生成唯一 ID
    const id = `lx_api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 创建新的脚本配置
    const newApiConfig: LxMusicScriptConfig = {
      id,
      name: scriptInfo.name,
      script: scriptContent,
      info: scriptInfo,
      sources: sourceKeys,
      enabled: true,
      createdAt: Date.now()
    };

    // 添加到列表
    const scripts = [...(settingsStore.setData.lxMusicScripts || []), newApiConfig];

    settingsStore.setSetData({
      lxMusicScripts: scripts,
      activeLxMusicApiId: id // 自动激活新添加的音源
    });

    message.success(`${t('common.success')}：${scriptInfo.name}`);

    // 导入成功后自动勾选
    if (!selectedSources.value.includes('lxMusic')) {
      selectedSources.value.push('lxMusic');
    }
  } catch (initError: any) {
    console.error('[MusicSourceSettings] 落雪音源脚本初始化失败:', initError);
    message.error(`${t('common.error')}：${initError.message}`);
  }
};

/**
 * 设置激活的落雪音源
 */
const setActiveLxApi = async (apiId: string) => {
  const api = lxMusicApis.value.find((a: LxMusicScriptConfig) => a.id === apiId);
  if (!api) {
    message.error(t('settings.playback.lxMusic.scripts.notFound'));
    return;
  }

  try {
    // 清除旧的 runner
    setLxMusicRunner(null);

    // 初始化新选中的脚本
    await initLxMusicRunner(api.script);

    // 更新激活的音源 ID
    activeLxApiId.value = apiId;

    // 确保 lxMusic 在已选音源中
    if (!selectedSources.value.includes('lxMusic')) {
      selectedSources.value.push('lxMusic');
    }

    message.success(t('settings.playback.lxMusic.scripts.switched', { name: api.name }));
  } catch (error: any) {
    console.error('[MusicSourceSettings] 切换落雪音源失败:', error);
    message.error(`${t('common.error')}：${error.message}`);
  }
};

/**
 * 删除落雪音源
 */
const removeLxApi = (apiId: string) => {
  const scripts = [...(settingsStore.setData.lxMusicScripts || [])];
  const index = scripts.findIndex((s) => s.id === apiId);

  if (index === -1) return;

  const removedScript = scripts[index];
  scripts.splice(index, 1);

  // 更新 store
  settingsStore.setSetData({
    lxMusicScripts: scripts
  });

  // 如果删除的是当前激活的音源
  if (activeLxApiId.value === apiId) {
    // 自动选择下一个可用音源，或者清空
    if (scripts.length > 0) {
      setActiveLxApi(scripts[0].id);
    } else {
      setLxMusicRunner(null);
      settingsStore.setSetData({ activeLxMusicApiId: null });
      // 从已选音源中移除 lxMusic
      const srcIndex = selectedSources.value.indexOf('lxMusic');
      if (srcIndex > -1) {
        selectedSources.value.splice(srcIndex, 1);
      }
    }
  }

  message.success(t('settings.playback.lxMusic.scripts.deleted', { name: removedScript.name }));
};

/**
 * 从 URL 导入落雪音源脚本
 */
const importLxMusicScriptFromUrl = async () => {
  const url = lxScriptUrl.value.trim();
  if (!url) {
    message.warning(t('settings.playback.lxMusic.scripts.enterUrl'));
    return;
  }

  // 验证 URL 格式
  try {
    new URL(url);
  } catch {
    message.error(t('settings.playback.lxMusic.scripts.invalidUrl'));
    return;
  }

  isImportingFromUrl.value = true;

  try {
    // 下载脚本内容
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();

    // 验证脚本格式 - 检查是否包含 lx-music 脚本的特征
    // 1. 检查是否有头部注释块（包含 @name、@version 等）
    const hasHeaderComment = /^\/\*+[\s\S]*?@name[\s\S]*?\*\//.test(content);
    // 2. 检查是否使用 lx API（lx.on 或 lx.send）
    const hasLxApi = content.includes('lx.on(') || content.includes('lx.send(');

    if (!hasHeaderComment && !hasLxApi) {
      throw new Error(t('settings.playback.lxMusic.scripts.invalidScript'));
    }

    // 使用统一的添加方法
    await addLxMusicScript(content);

    // 清空 URL 输入框
    lxScriptUrl.value = '';
  } catch (error: any) {
    console.error('从 URL 导入落雪音源脚本失败:', error);
    message.error(
      `${t('settings.playback.lxMusic.scripts.importOnline')} ${t('common.error')}：${error.message}`
    );
  } finally {
    isImportingFromUrl.value = false;
  }
};

/**
 * 开始重命名
 */
const startRenaming = (api: LxMusicScriptConfig) => {
  editingScriptId.value = api.id;
  editingName.value = api.name;
  nextTick(() => {
    renameInputRef.value?.focus();
  });
};

/**
 * 保存脚本名称
 */
const saveScriptName = (apiId: string) => {
  if (!editingName.value.trim()) {
    message.warning(t('settings.playback.lxMusic.scripts.nameRequired'));
    return;
  }

  const scripts = [...(settingsStore.setData.lxMusicScripts || [])];
  const index = scripts.findIndex((s) => s.id === apiId);

  if (index > -1) {
    scripts[index] = {
      ...scripts[index],
      name: editingName.value.trim()
    };

    settingsStore.setSetData({
      lxMusicScripts: scripts
    });

    message.success(t('settings.playback.lxMusic.scripts.renameSuccess'));
  }

  editingScriptId.value = null;
  editingName.value = '';
};

/**
 * 确认选择
 */
/**
 * 一个音源都没选时的兜底。不能拿内置那四个当默认——非桌面端它们压根不生效，勾了等于没勾。
 */
const DEFAULT_PLATFORMS: Platform[] = isElectron ? ['migu', 'kugou', 'kuwo', 'pyncmd'] : ['custom'];

const handleConfirm = () => {
  const selected = dropUnsupportedSources([...new Set(selectedSources.value)]);
  emit('update:sources', selected.length > 0 ? selected : DEFAULT_PLATFORMS);
  visible.value = false;
};

/**
 * 取消选择
 */
const handleCancel = () => {
  selectedSources.value = dropUnsupportedSources([...props.sources]);
  visible.value = false;
};

// ==================== 监听器 ====================
// 监听自定义插件内容变化
watch(
  () => settingsStore.setData.customApiPlugin,
  (newPluginContent: any) => {
    if (!newPluginContent) {
      const index = selectedSources.value.indexOf('custom');
      if (index > -1) {
        selectedSources.value.splice(index, 1);
      }
    }
  }
);

// 监听落雪音源列表变化
watch(
  [() => lxMusicApis.value.length, () => activeLxApiId.value],
  ([apiCount, activeId]) => {
    // 如果没有音源或没有激活的音源，自动从已选音源中移除 lxMusic
    if (apiCount === 0 || !activeId) {
      const index = selectedSources.value.indexOf('lxMusic');
      if (index > -1) {
        selectedSources.value.splice(index, 1);
      }
    }
  },
  { deep: true }
);

// 同步外部show属性变化
watch(
  () => props.show,
  (newVal: boolean) => {
    visible.value = newVal;
  }
);

// 同步内部visible变化
watch(
  () => visible.value,
  (newVal: boolean) => {
    emit('update:show', newVal);
  }
);

// 同步外部sources属性变化。immediate 让初值也过一遍过滤——初始值直接来自
// props.sources，里面可能带着非桌面端用不了的音源
watch(
  () => props.sources,
  (newVal: Platform[]) => {
    selectedSources.value = dropUnsupportedSources([...newVal]);
  },
  { deep: true, immediate: true }
);

// 把当前配置灌进粘贴框，用户可以直接在上面改。用户打字不会触发这里
// （文本框不写回 store），只有真的换了配置——URL 导入、恢复预置、应用——才会重排
watch(
  () => settingsStore.setData.customApiPlugin as string | undefined,
  (content) => {
    if (!content) {
      customApiJson.value = '';
      return;
    }
    try {
      customApiJson.value = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      customApiJson.value = content;
    }
  },
  { immediate: true }
);
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
