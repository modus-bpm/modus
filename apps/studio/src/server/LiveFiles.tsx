import { type ReactNode, useMemo } from 'react'
import type { Id } from '@modus-bpm/core/model/types'
import { canShow, type FilesApi, FilesContext, showBlob } from '../components/files'
import { isLive } from '../features/monitor/source'
import { useUi } from '../store/ui'
import { getFile, uploadFile } from './client'
import { useLive } from './useLive'

/**
 * Forms inside upload to the server and open files from it, as the person working, while the
 * Studio shows a server's work. `itemId` is the item the form belongs to; leave it out for a
 * form that has no item yet (a new request), where only the person's own uploads can be opened.
 * Over the simulation it changes nothing.
 */
export function LiveFiles({ itemId, children }: { itemId?: Id; children: ReactNode }) {
  const live = useLive(isLive)
  const appId = useUi((s) => s.appId)
  const user = useUi((s) => s.actingAs)
  const api = useMemo<FilesApi>(
    () => ({
      stored: true,
      upload: (file) => uploadFile(appId, file, { user }),
      open: async (file) => {
        if (!file.id) throw new Error('This is sample data: there is no file behind it.')
        // A file picked in this form is not on the item yet: it comes from the person's own uploads.
        const fresh = !itemId || file.uploadedBy === user
        let blob: Blob
        try {
          blob = await getFile(appId, file.id, itemId, canShow(file), { user })
        } catch (e) {
          if (!fresh || !itemId) throw e
          blob = await getFile(appId, file.id, undefined, canShow(file), { user })
        }
        showBlob(blob, file)
      },
    }),
    [appId, user, itemId],
  )
  if (!live) return <>{children}</>
  return <FilesContext.Provider value={api}>{children}</FilesContext.Provider>
}
