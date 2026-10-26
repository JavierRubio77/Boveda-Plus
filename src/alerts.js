export const ALERT_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

export function passwordAlerts(entries, now = Date.now()) {
  return entries.flatMap((entry) => {
    const changed = Date.parse(entry.lastChangedAt);
    const deferred = Date.parse(entry.alertSnoozedUntil);
    if (entry.alertsDisabled === true || !Number.isFinite(changed)) return [];
    const due = Math.max(changed + ALERT_INTERVAL_MS, Number.isFinite(deferred) ? deferred : 0);
    return now >= due ? [{ entry, days: Math.floor((now - changed) / 86_400_000) }] : [];
  }).sort((a, b) => b.days - a.days || String(a.entry.title || '').localeCompare(String(b.entry.title || ''), 'es'));
}

export function snoozePasswordAlert(entry, now = Date.now()) {
  return { ...entry, alertSnoozedUntil: new Date(now + ALERT_INTERVAL_MS).toISOString() };
}
