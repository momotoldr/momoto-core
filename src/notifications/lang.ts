/**
 * The locales Momoto ships. Mirrors `momoto-notify/src/types.ts`.
 *
 * Lives here rather than in the client so the auth modules can talk about a language
 * without importing the transport — and so the notification service stays the only
 * thing that knows what a language *means* for copy.
 */
export type Lang = 'en' | 'id'

/** Anything that isn't a locale we ship falls back to English. */
export function normalizeLang(raw: unknown): Lang {
  return String(raw ?? '').toLowerCase() === 'id' ? 'id' : 'en'
}
