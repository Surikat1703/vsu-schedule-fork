package com.personal.vsu.schedule;

import android.app.Activity;
import android.os.Build;
import android.view.Display;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AOD-режим: полноэкранный чёрный экран с минимальным энергопотреблением.
 * Скрывает системные панели, приглушает подсветку, включает пониженную
 * частоту обновления экрана и держит экран включённым.
 */
@CapacitorPlugin(name = "AodMode")
public class AodModePlugin extends Plugin {

    private static final float AOD_BRIGHTNESS = 0.05f;

    private boolean saved = false;
    private int prevModeId = -1;
    private float prevBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
    private boolean prevKeepScreenOn = false;

    @PluginMethod
    public void setActive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("active", false));
        Activity act = getActivity();
        if (act == null) {
            call.reject("no activity");
            return;
        }
        act.runOnUiThread(() -> {
            if (on) applyAod(act);
            else restore(act);
        });
        JSObject ret = new JSObject();
        ret.put("active", on);
        call.resolve(ret);
    }

    private void applyAod(Activity act) {
        Window w = act.getWindow();
        WindowManager.LayoutParams lp = w.getAttributes();

        if (!saved) {
            prevBrightness = lp.screenBrightness;
            prevKeepScreenOn = (w.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0;
            saved = true;
        }
        lp.screenBrightness = AOD_BRIGHTNESS;
        w.setAttributes(lp);
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        hideSystemBars(w);
        useLowestRefreshRate(w);
    }

    private void restore(Activity act) {
        Window w = act.getWindow();
        WindowManager.LayoutParams lp = w.getAttributes();
        if (saved) {
            lp.screenBrightness = prevBrightness;
            w.setAttributes(lp);
            if (!prevKeepScreenOn) w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            restoreRefreshRate(w);
            saved = false;
        }
        showSystemBars(w);
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars(Window w) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Разрешаем окну рисовать и под строками состояния/навигации
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @SuppressWarnings("deprecation")
    private void showSystemBars(Window w) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_DEFAULT);
            }
            w.setDecorFitsSystemWindows(true);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    /** Переключает окно на самый «медленный» режим экрана с тем же разрешением. */
    @SuppressWarnings("deprecation")
    private void useLowestRefreshRate(Window w) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            Display d = w.getWindowManager().getDefaultDisplay();
            Display.Mode cur = d.getMode();
            Display.Mode best = cur;
            for (Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() != cur.getPhysicalWidth()) continue;
                if (m.getPhysicalHeight() != cur.getPhysicalHeight()) continue;
                if (m.getRefreshRate() < best.getRefreshRate()) best = m;
            }
            if (best.getModeId() != cur.getModeId()) {
                prevModeId = cur.getModeId();
                WindowManager.LayoutParams a = w.getAttributes();
                a.preferredDisplayModeId = best.getModeId();
                w.setAttributes(a);
            }
        } catch (Exception ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private void restoreRefreshRate(Window w) {
        if (prevModeId <= 0) return;
        try {
            WindowManager.LayoutParams a = w.getAttributes();
            a.preferredDisplayModeId = prevModeId;
            w.setAttributes(a);
        } catch (Exception ignored) {
        }
        prevModeId = -1;
    }

    @Override
    protected void handleOnDestroy() {
        Activity act = getActivity();
        if (act != null && saved) act.runOnUiThread(() -> restore(act));
        super.handleOnDestroy();
    }
}
