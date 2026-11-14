// The look of the Workspace. A theme is a handful of choices (colours, type, corners, room, how
// fields are drawn) and, for whatever those don't reach, style rules of the organization's own.
// This file turns a theme into what a page needs: CSS custom properties, a few attributes and a
// style sheet that can't reach outside the Workspace or call out of the page.

import type { App, Design, Theme, ThemeFont } from './types'

/** The product's own look. */
export const DEFAULT_THEME: Theme = {
  primary: '#4f46e5',
  background: '#f6f7fb',
  surface: '#ffffff',
  text: '#0f172a',
  font: 'inter',
  radius: 'soft',
  density: 'comfortable',
  fields: 'outlined',
  labels: 'plain',
  header: 'light',
}

export const THEME_FONTS: Record<ThemeFont, { label: string; stack: string }> = {
  inter: { label: 'Inter', stack: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif" },
  system: { label: 'System', stack: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  serif: { label: 'Serif', stack: "ui-serif, 'Iowan Old Style', 'Palatino Linotype', Georgia, Cambria, 'Times New Roman', serif" },
  rounded: { label: 'Rounded', stack: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Nunito, system-ui, sans-serif" },
  mono: { label: 'Monospace', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
}

/** Logos and pictures are kept in the design; this keeps the design a size a server takes. */
export const MAX_IMAGE_BYTES = 300_000
export const MAX_CSS_CHARS = 20_000
const IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);/

/** The look in force for an application: the organization's, with the application's changes over it. */
export function themeFor(design: Pick<Design, 'theme'> | undefined, app?: Pick<App, 'theme'>): Theme {
  const picked = (t: Partial<Theme> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([, v]) => v !== undefined && v !== ''))
  return { ...DEFAULT_THEME, ...picked(design?.theme), ...picked(app?.theme) } as Theme
}

/** True when a theme changes nothing about the product's look. */
export function isDefaultTheme(t: Theme): boolean {
  return (Object.keys(DEFAULT_THEME) as Array<keyof Theme>).every((k) => t[k] === DEFAULT_THEME[k]) && !t.name && !t.logo && !t.css
}

// ---------- Colour ----------

type Rgb = [number, number, number]

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v.trim())

function rgb(hex: string): Rgb {
  const h = hex.trim().slice(1)
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb
}

const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

/** `amount` of `b` mixed into `a` (0: all a, 1: all b). */
export function mix(a: string, b: string, amount: number): string {
  const x = rgb(a)
  const y = rgb(b)
  return hex(x.map((v, i) => v + (y[i]! - v) * amount) as Rgb)
}

/** Relative luminance (WCAG 2). */
function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast between two colours, 1 (none) to 21. Text wants 4.5 or more. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white, whichever reads better on this colour. */
export const onColor = (c: string) => (contrast(c, '#ffffff') >= contrast(c, '#0f172a') ? '#ffffff' : '#0f172a')

// ---------- A theme as CSS ----------

const RADIUS: Record<Theme['radius'], [sm: string, md: string, lg: string, xl: string]> = {
  square: ['0px', '0px', '0px', '0px'],
  soft: ['0.25rem', '0.375rem', '0.5rem', '0.75rem'],
  round: ['0.5rem', '0.75rem', '1rem', '1.25rem'],
  pill: ['0.75rem', '9999px', '1.25rem', '1.5rem'],
}

/**
 * The custom properties a theme sets on the Workspace. They take the place of the product's own
 * palette there (brand shades, greys, white, the page), so everything drawn with it follows.
 */
export function themeVars(theme: Theme): Record<string, string> {
  const t = { ...theme, primary: isHex(theme.primary) ? theme.primary : DEFAULT_THEME.primary, background: isHex(theme.background) ? theme.background : DEFAULT_THEME.background, surface: isHex(theme.surface) ? theme.surface : DEFAULT_THEME.surface, text: isHex(theme.text) ? theme.text : DEFAULT_THEME.text }
  // Greys run from the surface towards the text, so they stay greys of this theme, light or dark.
  const grey = (amount: number) => mix(t.surface, t.text, amount)
  const dark = luminance(t.surface) < 0.2
  // Shades of the primary: tints towards the surface, and a deeper one for hover and text on tints.
  const tint = (amount: number) => mix(t.primary, t.surface, amount)
  const deep = mix(t.primary, dark ? '#ffffff' : '#000000', dark ? 0.25 : 0.18)
  const side = t.header === 'brand' ? t.primary : t.header === 'dark' ? '#0f172a' : t.surface
  const [sm, md, lg, xl] = RADIUS[t.radius] ?? RADIUS.soft
  return {
    '--color-brand-50': tint(0.92),
    '--color-brand-100': tint(0.84),
    '--color-brand-200': tint(0.68),
    '--color-brand-300': tint(0.5),
    '--color-brand-400': tint(0.25),
    '--color-brand-500': tint(0.1),
    '--color-brand-600': t.primary,
    '--color-brand-700': deep,
    '--color-brand-800': mix(deep, t.text, 0.25),
    '--theme-on-brand': onColor(t.primary),
    '--color-canvas': t.background,
    '--color-white': t.surface,
    '--color-slate-50': grey(0.03),
    '--color-slate-100': grey(0.07),
    '--color-slate-200': grey(0.13),
    '--color-slate-300': grey(0.22),
    '--color-slate-400': grey(0.42),
    '--color-slate-500': grey(0.58),
    '--color-slate-600': grey(0.72),
    '--color-slate-700': grey(0.84),
    '--color-slate-800': grey(0.93),
    '--color-slate-900': t.text,
    '--theme-side': side,
    '--theme-on-side': t.header === 'light' ? t.text : onColor(side),
    '--font-sans': (THEME_FONTS[t.font] ?? THEME_FONTS.inter).stack,
    '--radius-sm': sm,
    '--radius-md': md,
    '--radius-lg': lg,
    '--radius-xl': xl,
  }
}

/** What the Workspace's root element carries besides the properties: the choices CSS selects on. */
export function themeAttrs(theme: Theme): Record<string, string> {
  return { 'data-theme-density': theme.density, 'data-theme-fields': theme.fields, 'data-theme-labels': theme.labels, 'data-theme-header': theme.header }
}

/**
 * The organization's own style rules, made safe to put in the page and kept to the Workspace.
 * Nothing in them may load anything (no @import, no url() but a picture held in the rules
 * themselves), so a style sheet can't send what is on the screen anywhere; nothing may close the
 * style element; and every rule is nested under `scope`, so it can't restyle the Studio.
 */
export function scopedCss(css: string | undefined, scope = '.modus-themed'): string {
  if (!css?.trim()) return ''
  const safe = css
    .slice(0, MAX_CSS_CHARS)
    .replace(/<\/?[a-z!][^>]*>?/gi, '')
    .replace(/\\/g, '')
    .replace(/@(import|charset|namespace)[^;{}]*;?/gi, '')
    .replace(/url\(\s*(?!['"]?data:image\/(?:png|jpeg|gif|webp);base64,)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(|-moz-binding|behavior\s*:/gi, 'blocked(')
  // Braces must balance, or a stray one would close the scope and let the rest out.
  let depth = 0
  for (const ch of safe) {
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return ''
  }
  if (depth !== 0) return ''
  return `${scope} {\n${safe}\n}`
}

/** What is wrong with a theme as data; empty when nothing is. */
export function themeProblems(theme: unknown): string[] {
  if (theme === undefined) return []
  if (typeof theme !== 'object' || theme === null) return ['The look is not one Modus knows.']
  const t = theme as Partial<Theme>
  const out: string[] = []
  for (const k of ['primary', 'background', 'surface', 'text'] as const) if (t[k] !== undefined && !isHex(t[k])) out.push(`The ${k} colour is not a hex colour such as #4f46e5.`)
  if (t.logo !== undefined && t.logo !== '' && (typeof t.logo !== 'string' || !IMAGE.test(t.logo))) out.push('The logo is not an image kept in the design.')
  if (typeof t.logo === 'string' && t.logo.length > MAX_IMAGE_BYTES * 1.4) out.push(`The logo is larger than ${Math.round(MAX_IMAGE_BYTES / 1000)} KB.`)
  if (t.css !== undefined && (typeof t.css !== 'string' || t.css.length > MAX_CSS_CHARS)) out.push(`The style rules are longer than ${MAX_CSS_CHARS.toLocaleString('en-US')} characters.`)
  if (t.name !== undefined && (typeof t.name !== 'string' || t.name.length > 80)) out.push('The name is longer than 80 characters.')
  const choice = <K extends keyof Theme>(k: K, allowed: readonly string[]) => {
    if (t[k] !== undefined && !allowed.includes(t[k] as string)) out.push(`The look’s ${k} is not a choice Modus knows.`)
  }
  choice('font', Object.keys(THEME_FONTS))
  choice('radius', Object.keys(RADIUS))
  choice('density', ['compact', 'comfortable', 'roomy'])
  choice('fields', ['outlined', 'filled', 'underlined'])
  choice('labels', ['plain', 'bold', 'caps'])
  choice('header', ['light', 'brand', 'dark'])
  return out
}
