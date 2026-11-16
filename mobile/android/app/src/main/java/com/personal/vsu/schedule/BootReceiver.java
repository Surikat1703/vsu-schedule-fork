package com.personal.vsu.schedule;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !"android.intent.action.QUICKBOOT_POWERON".equals(action) &&
            !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) &&
            !Intent.ACTION_TIME_CHANGED.equals(action) &&
            !Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences(ClassTimerService.PREFS_NAME, Context.MODE_PRIVATE);

        // После перезагрузки и обновления приложения старые уведомления
        // (и островок) сбрасываются системой.
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            prefs.edit().putBoolean(ClassTimerService.KEY_ISLAND_ACTIVE, false).apply();
        }

        boolean isEnabled = prefs.getBoolean(ClassTimerService.KEY_IS_ENABLED, true);
        boolean vacationMode = prefs.getBoolean(ClassTimerService.KEY_VACATION_MODE, false);
        boolean showTimer = prefs.getBoolean(ClassTimerService.KEY_SHOW_TIMER, true);

        if (isEnabled && !vacationMode && showTimer) {
            ClassTimerService.startOrUpdate(context);
        }
    }
}
