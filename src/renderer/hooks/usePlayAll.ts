import { ref } from 'vue';

import { getMusicDetail } from '@/api/music';
import { usePlayerStore } from '@/store/modules/player';
import type { SongResult } from '@/types/music';

type PlayAllOptions = {
  /** 取当前已经渲染出来的歌曲（按显示顺序） */
  getLoaded: () => SongResult[];
  /**
   * 取完整列表。走自己的批量详情接口，**不要**去驱动列表的分页状态——
   * 播放会写进播放历史，历史页的 watch 会因此把分页重置回第一页，两下里抢同一个
   * currentPage 会把补齐打断在半路。
   */
  loadAll: () => Promise<SongResult[]>;
};

/** 详情接口把 id 全拼在 URL 里，一次塞太多会被服务端拒掉 */
const DETAIL_CHUNK_SIZE = 100;

/**
 * 按 id 批量取歌曲详情，保持传入顺序。
 */
export const fetchSongsByIds = async (ids: number[]): Promise<SongResult[]> => {
  const fetched: SongResult[] = [];

  for (let i = 0; i < ids.length; i += DETAIL_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DETAIL_CHUNK_SIZE);
    try {
      const res = await getMusicDetail(chunk);
      if (res.data?.songs) {
        fetched.push(
          ...res.data.songs.map((song: SongResult) => ({
            ...song,
            picUrl: song.al?.picUrl || '',
            source: 'netease' as const
          }))
        );
      }
    } catch (error) {
      console.error('[usePlayAll] 批量获取歌曲详情失败:', error);
    }
  }

  // 接口不保证返回顺序跟请求一致，按传入的 id 重排一遍
  const byId = new Map(fetched.map((song) => [String(song.id), song]));
  return ids.map((id) => byId.get(String(id))).filter((song): song is SongResult => !!song);
};

/**
 * 「播放全部」。
 *
 * 收藏和历史列表都是分页的（滚到底才加载下一页），所以这里不把「全部」理解成
 * 「等加载完再播」——那要用户干等好几个请求。做法是：先用已经渲染出来的那些立刻开播，
 * 完整列表在后台单独拉，拉到了再把播放列表整体换成完整的。
 *
 * 换的时候用 setPlayList(full)，不传 keepIndex：它会拿正在播的那首在新列表里重新定位
 * 索引（见 playlist.ts 里 keepIndex=false 那条分支），即使后台这段时间列表顺序变了
 * （比如刚播的这首被记进了播放历史、跑到了最前面）也能对上。随机模式下 performShuffle
 * 会把正在播的排到第一位并把索引归零，当前这首同样不会被打断。
 */
export const usePlayAll = (options: PlayAllOptions) => {
  const playerStore = usePlayerStore();

  /** 后台是否正在补齐。歌已经响了，按钮不用转圈，给需要的地方留个状态 */
  const filling = ref(false);

  /**
   * 变更计数。分类/排序之类的切换会让调用方 cancel()，后台那一轮就此作废——
   * 否则它拿着新列表去覆盖正在播的这一份。
   */
  let generation = 0;

  const cancel = () => {
    generation++;
    filling.value = false;
  };

  const playAll = () => {
    const loaded = options.getLoaded();
    if (loaded.length === 0) return;

    // 先让这一份跑起来
    playerStore.setPlayList([...loaded]);
    void playerStore.setPlay(loaded[0]);

    void fillUp(loaded);
  };

  const fillUp = async (firstBatch: SongResult[]) => {
    if (filling.value) return;

    const myGeneration = ++generation;
    const stale = () => generation !== myGeneration;

    filling.value = true;
    try {
      const full = await options.loadAll();
      if (stale()) return;
      if (full.length <= firstBatch.length) return;

      // 用户可能已经点了别的歌或别的列表，那就不能再拿这份结果去覆盖。
      // 播放列表还是我们设进去的那一份（长度和第一首都没变）才认。
      const playlist = playerStore.playList;
      if (playlist.length !== firstBatch.length || playlist[0]?.id !== firstBatch[0]?.id) return;

      playerStore.setPlayList([...full]);
    } catch (error) {
      console.error('[usePlayAll] 补齐播放列表失败:', error);
    } finally {
      if (!stale()) filling.value = false;
    }
  };

  return { playAll, filling, cancel };
};
