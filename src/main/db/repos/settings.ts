import { all, get, now, run } from '../index'

export function getSetting(key: string): string | null {
  const r = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
  return r?.value ?? null
}

export function setSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now(),
  )
}

export function allSettings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    out[r.key] = r.value
  }
  return out
}

export function getJsonSetting<T>(key: string, fallback: T): T {
  const raw = getSetting(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value))
}
