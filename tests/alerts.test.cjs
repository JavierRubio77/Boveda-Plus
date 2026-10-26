const { test } = require('node:test');
const assert = require('node:assert/strict');
const day = 86_400_000;
const start = Date.parse('2026-01-01T12:00:00Z');

test('alerts start exactly at 90 days; legacy entries default to enabled', async () => {
  const { passwordAlerts } = await import('../src/alerts.js');
  const entry = { id: 'a', lastChangedAt: new Date(start).toISOString() };
  assert.equal(passwordAlerts([entry], start + 90 * day - 1).length, 0);
  assert.equal(passwordAlerts([entry], start + 90 * day)[0].days, 90);
  assert.equal(passwordAlerts([{ ...entry, alertsDisabled: true }], start + 900 * day).length, 0);
  assert.equal(passwordAlerts([{ ...entry, lastChangedAt: 'invalid' }], start + 900 * day).length, 0);
});

test('repeated postponement preserves credentials and original date while age reaches 180 and 270 days', async () => {
  const { passwordAlerts, snoozePasswordAlert } = await import('../src/alerts.js');
  const original = { id: 'a', password: 'keep', notes: 'keep notes', lastChangedAt: new Date(start).toISOString() };
  const first = snoozePasswordAlert(original, start + 90 * day);
  assert.equal(first.lastChangedAt, original.lastChangedAt);
  assert.equal(first.password, original.password);
  assert.equal(first.notes, original.notes);
  assert.equal(original.alertSnoozedUntil, undefined);
  assert.equal(passwordAlerts([first], start + 180 * day - 1).length, 0);
  assert.equal(passwordAlerts([first], start + 180 * day)[0].days, 180);
  const second = snoozePasswordAlert(first, start + 180 * day);
  assert.equal(passwordAlerts([second], start + 270 * day - 1).length, 0);
  assert.equal(passwordAlerts([second], start + 270 * day)[0].days, 270);
  const saved = JSON.parse(JSON.stringify(second));
  assert.equal(passwordAlerts([saved], start + 270 * day)[0].days, 270);
});

test('postponement runs from action time and newer passwords wait their own 90 days', async () => {
  const { passwordAlerts, snoozePasswordAlert } = await import('../src/alerts.js');
  const entry = { lastChangedAt: new Date(start).toISOString() };
  const snoozed = snoozePasswordAlert(entry, start + 120 * day);
  assert.equal(passwordAlerts([snoozed], start + 180 * day).length, 0);
  assert.equal(passwordAlerts([snoozed], start + 210 * day)[0].days, 210);
  assert.equal(passwordAlerts([{ lastChangedAt: new Date(start + 120 * day).toISOString() }], start + 180 * day).length, 0);
});
