import { COUNTRY_CODES } from '../data/countries.js'
import { REGIONS } from '../data/regionsId.js'

/**
 * Where a user lives: one of three shapes, and nothing in between.
 *
 * - **None** — all three columns null.
 * - **An Indonesian regency or city** — `countryCode = 'ID'` plus a Kemendagri
 *   kabupaten/kota `regionCode` from `data/regionsId.ts`. Never free text.
 * - **Abroad** — any other ISO 3166-1 alpha-2 `countryCode`, with an optional free-text
 *   `cityName`.
 *
 * The migration backs this with CHECK constraints; this module is the one place that
 * reads, validates and labels it.
 */

export interface Region {
  /** Kemendagri kabupaten/kota code, e.g. "32.73". What `User.regionCode` stores. */
  code: string
  /** Official name, e.g. "Kota Bandung". Shown in the picker. */
  name: string
  /** What a testimonial card prints: "Bandung", "Kab. Bandung", "Jakarta Selatan". */
  shortName: string
  type: 'kabupaten' | 'kota'
  provinceCode: string
  provinceName: string
  /** Present when a later import no longer found this code. */
  retired?: true
}

/** The three `User` columns. */
export interface LocationColumns {
  countryCode: string | null
  regionCode: string | null
  cityName: string | null
}

/** A user's location as their own profile sees it. */
export interface PublicLocation {
  countryCode: string
  regionCode: string | null
  /** The region's official name, resolved here so the profile can show a saved pick
   * before the full list has loaded. */
  regionName: string | null
  /** The region's province, so the profile's province select can show a saved pick
   * before (or without) the province list. */
  provinceCode: string | null
  provinceName: string | null
  cityName: string | null
}

export const INDONESIA = 'ID'
export const MAX_CITY_NAME = 60

/** Letters in any script, spaces, dots, apostrophes and hyphens — "St. John's", "Đà Nẵng". */
const CITY_NAME_RE = /^[\p{L}\s.'-]+$/u

const regionsByCode = new Map(REGIONS.map((region) => [region.code, region]))
const countryCodes = new Set(COUNTRY_CODES)

/** Regions still offered in the picker, i.e. not retired. */
export const activeRegions: readonly Region[] = REGIONS.filter((region) => !region.retired)

/** A region's name without its "Kota" / "Kabupaten" (and "Administrasi") prefix, lowercased
 * — the order the picker lists regions in, so Kota Bandung and Kab. Bandung sit together. */
function regionSortKey(name: string): string {
  return name.replace(/^(Kota|Kabupaten) (Administrasi )?/, '').toLowerCase()
}

export interface Province {
  code: string
  name: string
}

/** Provinces that have at least one active region, by name. */
export const provinces: readonly Province[] = [
  ...new Map(activeRegions.map((region) => [region.provinceCode, region.provinceName])),
]
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name, 'id'))

/** A province's active regions in picker order, or null for an unknown province. */
export function regionsInProvince(provinceCode: string): readonly Region[] | null {
  if (!provinces.some((province) => province.code === provinceCode)) return null
  return activeRegions
    .filter((region) => region.provinceCode === provinceCode)
    .sort((a, b) => regionSortKey(a.name).localeCompare(regionSortKey(b.name), 'id'))
}

export { COUNTRY_CODES }

export function findRegion(code: string): Region | undefined {
  return regionsByCode.get(code)
}

export function isActiveRegion(code: string): boolean {
  const region = regionsByCode.get(code)
  return region !== undefined && !region.retired
}

export function isCountryCode(code: string): boolean {
  return countryCodes.has(code)
}

/**
 * A typed city name, normalised: trimmed, inner whitespace collapsed, empty → null.
 * `undefined` means the value is unusable (wrong type, a disallowed character, too long).
 */
function normalizeCityName(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return undefined
  const city = raw.trim().replace(/\s+/g, ' ')
  if (city === '') return null
  if (city.length > MAX_CITY_NAME || !CITY_NAME_RE.test(city)) return undefined
  return city
}

/**
 * Validate `location` from a `PATCH /auth/me` body into the three columns, or null when
 * it isn't one of the accepted shapes:
 *
 * - `null` → clear it;
 * - `{ regionCode }` → an active region, or the user's current one even if it has since
 *   been retired, so a Kemendagri update never makes an untouched profile fail to save;
 * - `{ countryCode, cityName? }` → a known country other than Indonesia.
 */
export function parseLocation(
  raw: unknown,
  currentRegionCode: string | null,
): LocationColumns | null {
  if (raw === null) return { countryCode: null, regionCode: null, cityName: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>

  if (body.regionCode !== undefined) {
    if (body.countryCode !== undefined || body.cityName !== undefined) return null
    const code = body.regionCode
    if (typeof code !== 'string') return null
    const allowed = isActiveRegion(code) || (code === currentRegionCode && findRegion(code))
    if (!allowed) return null
    return { countryCode: INDONESIA, regionCode: code, cityName: null }
  }

  const country = body.countryCode
  if (typeof country !== 'string' || country === INDONESIA || !isCountryCode(country)) return null
  const cityName = normalizeCityName(body.cityName)
  if (cityName === undefined) return null
  return { countryCode: country, regionCode: null, cityName }
}

/** The user's location for their own `PublicUser` payload, or null when none is set. */
export function locationFor(user: LocationColumns): PublicLocation | null {
  if (!user.countryCode) return null
  const region = user.regionCode ? findRegion(user.regionCode) : undefined
  return {
    countryCode: user.countryCode,
    regionCode: user.regionCode,
    regionName: region?.name ?? null,
    provinceCode: region?.provinceCode ?? null,
    provinceName: region?.provinceName ?? null,
    cityName: user.cityName,
  }
}

/** A place as a public testimonial card prints it. The card adds the country name itself,
 * in the reader's language, so only the code travels. */
export interface PublicPlace {
  countryCode: string
  /** The region's short name in Indonesia ("Bandung", "Kab. Bandung"); the typed city
   * abroad, or null when there isn't one. */
  name: string | null
}

/** The user's place for a public card, or null when none is set. Never the region code. */
export function placeFor(user: LocationColumns): PublicPlace | null {
  if (!user.countryCode) return null
  if (user.countryCode === INDONESIA) {
    const region = user.regionCode ? findRegion(user.regionCode) : undefined
    return region ? { countryCode: INDONESIA, name: region.shortName } : null
  }
  return { countryCode: user.countryCode, name: user.cityName }
}

const englishRegionNames = new Intl.DisplayNames(['en'], { type: 'region' })

/**
 * A one-line label for the admin console: "Kota Bandung, Indonesia", "Tokyo, Japan",
 * "Japan". English country names — the console is English-only.
 */
export function placeLabel(user: LocationColumns): string | null {
  const location = locationFor(user)
  if (!location) return null
  if (location.regionName) return `${location.regionName}, Indonesia`
  const country = englishRegionNames.of(location.countryCode) ?? location.countryCode
  return location.cityName ? `${location.cityName}, ${country}` : country
}
