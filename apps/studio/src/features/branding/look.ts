import { useMemo } from 'react'
import { MAX_IMAGE_BYTES, themeFor } from '@modus-bpm/core/model/theme'
import type { Theme } from '@modus-bpm/core/model/types'
import { useLive } from '../../server/useLive'
import { useWork } from '../../server/useWork'
import { useDesign } from '../../store/design'
import { useUi } from '../../store/ui'
import { isLive } from '../monitor/source'

/**
 * The look of the open application's Workspace: from this browser's design, or, while the
 * Workspace shows a server's work, from the design the server sent.
 */
export function useWorkspaceLook(): Theme {
  const appId = useUi((s) => s.appId)
  const live = useLive(isLive)
  const own = useDesign((s) => s.design)
  const served = useWork((s) => (s.appId === appId ? s.design : undefined))
  return useMemo(() => {
    const design = live && served ? served : own
    return themeFor(design, design.apps.find((a) => a.id === appId))
  }, [live, served, own, appId])
}

/** The look a designer is editing, for previews in the Studio: always the design on the designer's desk. */
export function useDesignLook(appId: string): Theme {
  const design = useDesign((s) => s.design)
  return useMemo(() => themeFor(design, design.apps.find((a) => a.id === appId)), [design, appId])
}

const IMAGE_KINDS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

/** A picked picture as a data URL, to keep in the design. Rejects with a message for the person. */
export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!IMAGE_KINDS.includes(file.type)) return reject(new Error('Pick a PNG, JPEG, GIF, WebP or SVG picture.'))
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error(`That picture is ${Math.round(file.size / 1000)} KB. Pictures kept in the design can be up to ${Math.round(MAX_IMAGE_BYTES / 1000)} KB.`))
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('That picture could not be read.'))
    reader.readAsDataURL(file)
  })
}
