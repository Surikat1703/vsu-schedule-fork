package com.personal.vsu.schedule;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ClassTimer")
public class ClassTimerPlugin extends Plugin {

    @PluginMethod
    public void setScheduleData(PluginCall call) {
        String sched0 = call.getString("sched0", "{}");
        String sched1 = call.getString("sched1", "{}");
        Integer anchorWeekType = call.getInt("anchorWeekType", 0);
        String anchorMonday = call.getString("anchorMonday", "");
        Boolean vacationMode = call.getBoolean("vacationMode", false);
        Boolean showTimer = call.getBoolean("showTimer", true);
        Integer timerStartMode = call.getInt("timerStartMode", 0);
        String dateOverrides = call.getString("dateOverrides", "{}");

        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(ClassTimerService.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(ClassTimerService.KEY_SCHED_0, sched0)
                .putString(ClassTimerService.KEY_SCHED_1, sched1)
                .putString(ClassTimerService.KEY_DATE_OVERRIDES, dateOverrides != null ? dateOverrides : "{}")
                .putInt(ClassTimerService.KEY_ANCHOR_WEEK_TYPE, anchorWeekType != null ? anchorWeekType : 0)
                .putString(ClassTimerService.KEY_ANCHOR_MONDAY, anchorMonday)
                .putBoolean(ClassTimerService.KEY_VACATION_MODE, vacationMode != null ? vacationMode : false)
                .putBoolean(ClassTimerService.KEY_SHOW_TIMER, showTimer != null ? showTimer : true)
                .putInt(ClassTimerService.KEY_START_MODE, timerStartMode != null ? timerStartMode : 0)
                .apply();

        boolean isEnabled = prefs.getBoolean(ClassTimerService.KEY_IS_ENABLED, true);
        boolean hasSchedule = (sched0 != null && sched0.length() > 2)
                || (sched1 != null && sched1.length() > 2)
                || (dateOverrides != null && dateOverrides.length() > 2);
        if (isEnabled && !Boolean.TRUE.equals(vacationMode)
                && !Boolean.FALSE.equals(showTimer) && hasSchedule) {
            ClassTimerService.startOrUpdate(ctx);
        } else {
            // Раньше сервис оставался жить и продолжал держать островок
            // с устаревшим текстом после выключения таймера/ухода на каникулы.
            ClassTimerService.stop(ctx);
        }

        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", true);
        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(ClassTimerService.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(ClassTimerService.KEY_IS_ENABLED, enabled).apply();

        if (Boolean.TRUE.equals(enabled)) {
            ClassTimerService.startOrUpdate(ctx);
        } else {
            ClassTimerService.stop(ctx);
        }

        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(ClassTimerService.PREFS_NAME, Context.MODE_PRIVATE);
        boolean isEnabled = prefs.getBoolean(ClassTimerService.KEY_IS_ENABLED, true);

        JSObject ret = new JSObject();
        ret.put("enabled", isEnabled);
        call.resolve(ret);
    }
}
