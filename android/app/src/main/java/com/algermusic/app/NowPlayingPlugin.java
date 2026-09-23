package com.algermusic.app;

import android.Manifest;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 前端 ↔ {@link NowPlayingService} 的桥。
 *
 * checkPermissions / requestPermissions 由 Capacitor 的 Plugin 基类提供，
 * 这里声明了 @Permission 别名即可在 JS 侧直接调用（Android 13+ 需要通知权限）。
 */
@CapacitorPlugin(
        name = "NowPlaying",
        permissions = {
            @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public class NowPlayingPlugin extends Plugin {

    /**
     * 存成字段再挂：{@code this::emitControl} 每次求值都是一个新的 lambda 对象，
     * 摘除时就没法用它判断「当前挂着的还是不是我自己」。
     */
    private final NowPlayingService.ControlListener controlListener = this::emitControl;

    @Override
    public void load() {
        // Service 可能比插件活得久（播放中 Activity 重建），重新挂一次即可
        NowPlayingService.setControlListener(controlListener);
        AppLog.log("NowPlaying", "控制指令监听已挂载");
    }

    @Override
    protected void handleOnDestroy() {
        // 避免通知按键打到一个已经销毁的 bridge 上；只摘自己挂的那一份
        NowPlayingService.clearControlListener(controlListener);
        AppLog.log("NowPlaying", "控制指令监听已摘除");
    }

    /** 首次播放：拉起前台服务并显示通知 */
    @PluginMethod
    public void start(PluginCall call) {
        push(call);
        call.resolve();
    }

    /** 换歌 / 播放状态变化：刷新元数据与 PlaybackState */
    @PluginMethod
    public void update(PluginCall call) {
        push(call);
        call.resolve();
    }

    /**
     * 只切换播放态，保持通知不被重建。
     * 服务没起来时直接忽略：前端只在 start 之后才会调这个方法。
     */
    @PluginMethod
    public void setPlaying(PluginCall call) {
        boolean isPlaying = Boolean.TRUE.equals(call.getBoolean("isPlaying", false));
        NowPlayingService service = NowPlayingService.getInstance();
        if (service != null) {
            service.setPlaying(isPlaying);
        }
        call.resolve();
    }

    /** 停止播放：移除通知、释放 MediaSession */
    @PluginMethod
    public void stop(PluginCall call) {
        NowPlayingService service = NowPlayingService.getInstance();
        if (service != null) {
            service.shutdown();
        }
        call.resolve();
    }

    private void push(PluginCall call) {
        NowPlayingService.Update update = new NowPlayingService.Update();
        update.title = value(call.getString("title", ""));
        update.artist = value(call.getString("artist", ""));
        update.album = value(call.getString("album", ""));
        update.cover = value(call.getString("cover", ""));
        update.duration = value(call.getDouble("duration", 0d));
        update.position = value(call.getDouble("position", 0d));
        update.isPlaying = Boolean.TRUE.equals(call.getBoolean("isPlaying", false));

        NowPlayingService service = NowPlayingService.getInstance();
        if (service != null) {
            service.apply(update);
        } else {
            NowPlayingService.start(getContext(), update);
        }
    }

    /** 控制指令回传前端。焦点回调和媒体按键可能来自非主线程，统一回主线程再碰 WebView */
    private void emitControl(String action) {
        JSObject data = new JSObject();
        data.put("action", action);

        // 这一行是「原生已经把指令交给渲染进程」的分界点。排查按键没反应时，
        // 拿它和渲染进程的「[nativeNowPlaying] 收到原生控制指令」对齐：
        // 只有前者没有后者，说明指令进了 WebView 但 JS 没跑（渲染进程被冻结 / 已销毁）；
        // 两个都没有，说明指令在 dispatchControl 那一步就因为无监听者被丢了。
        AppLog.log("NowPlaying", "投递控制指令: " + action);
        getBridge().executeOnMainThread(() -> notifyListeners("control", data, false));
    }

    private static String value(String input) {
        return input == null ? "" : input;
    }

    private static double value(Double input) {
        return input == null ? 0d : input;
    }
}
