package com.algermusic.app;

import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 把系统栏的真实高度交给前端（单位 CSS px）。
 *
 * Android WebView 里的 env(safe-area-inset-*) 只反映屏幕挖孔，取不到状态栏和手势条的高度；
 * 而 targetSdk 35 起系统强制 edge-to-edge，页面直接画到状态栏下面，前端拿不到高度就必然重叠。
 * 所以由原生侧读 WindowInsets 算好，前端写进 --safe-area-inset-* 变量。
 */
@CapacitorPlugin(name = "Insets")
public class InsetsPlugin extends Plugin {

    @PluginMethod
    public void getInsets(PluginCall call) {
        View decorView = getActivity().getWindow().getDecorView();
        WindowInsetsCompat windowInsets = WindowInsetsCompat.toWindowInsetsCompat(
            decorView.getRootWindowInsets(),
            decorView
        );

        int top = 0;
        int bottom = 0;
        int left = 0;
        int right = 0;

        if (windowInsets != null) {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            top = bars.top;
            bottom = bars.bottom;
            left = bars.left;
            right = bars.right;
        }

        // 原生是物理 px，前端要 CSS px
        float density = getActivity().getResources().getDisplayMetrics().density;
        if (density <= 0) density = 1;

        JSObject ret = new JSObject();
        ret.put("top", top / density);
        ret.put("bottom", bottom / density);
        ret.put("left", left / density);
        ret.put("right", right / density);
        call.resolve(ret);
    }
}
