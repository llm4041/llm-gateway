import { get, run } from './index';

export function getSetting(key: string): unknown | null {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    Date.now(),
  );
}

export function initDefaultSettings(defaults: Record<string, unknown>): void {
  const existing = getSetting('system') as Record<string, unknown> | null;
  if (!existing) {
    setSetting('system', defaults);
    return;
  }
  let dirty = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in existing)) {
      existing[k] = v;
      dirty = true;
    }
  }
  if (dirty) setSetting('system', existing);
}
