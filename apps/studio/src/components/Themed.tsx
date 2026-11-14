import { type CSSProperties, type ReactNode, useId, useMemo } from 'react'
import { scopedCss, themeAttrs, themeVars } from '@modus-bpm/core/model/theme'
import type { Theme } from '@modus-bpm/core/model/types'
import { cx } from './ui'

/**
 * Everything inside is drawn in a theme: the Workspace, or a preview of it in the Studio. The
 * theme's choices become the palette's own properties here (index.css), and the organization's
 * own style rules are kept to this element.
 */
export function Themed({ theme, className, children }: { theme: Theme; className?: string; children: ReactNode }) {
  const scope = useId()
  const vars = useMemo(() => themeVars(theme) as CSSProperties, [theme])
  const css = useMemo(() => scopedCss(theme.css, `[data-theme-scope="${scope}"]`), [theme.css, scope])
  return (
    <div className={cx('modus-themed', className)} style={vars} data-theme-scope={scope} {...themeAttrs(theme)}>
      {css && <style>{css}</style>}
      {children}
    </div>
  )
}
