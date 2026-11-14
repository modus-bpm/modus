import { createContext, useContext } from 'react'
import type { AttachmentValue } from '@modus-bpm/core/model/format'

// How a form keeps and opens files. In the browser simulation a picked file lives in the page
// (an object URL, gone on reload). Over a server it is uploaded, and opened by fetching it as
// the person working (server/LiveFiles.tsx provides that).

export interface FilesApi {
  /** Keep a picked file; the answer goes in the item's data. Rejects with a message for the person. */
  upload: (file: File) => Promise<AttachmentValue>
  /** Show or save a file. Rejects with a message for the person. */
  open: (file: AttachmentValue) => Promise<void>
  /** True when files are stored somewhere that outlives the page. */
  stored: boolean
  /** The largest file the store takes, in megabytes, when it has a limit of its own. */
  maxMb?: number
}

/** Kinds a browser shows in place; the rest are saved to disk. */
const SHOWN = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/

/** Open a blob in a new tab when the browser can show it, or save it under the file's name. */
export function showBlob(blob: Blob, file: AttachmentValue) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  if (SHOWN.test(blob.type)) {
    a.target = '_blank'
    a.rel = 'noreferrer'
  } else a.download = file.name
  a.click()
  // Long enough for the new tab or the download to have taken it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const canShow = (file: AttachmentValue) => SHOWN.test(file.kind)

const inPage: FilesApi = {
  stored: false,
  upload: async (file) => ({ name: file.name, size: file.size, kind: file.type, url: URL.createObjectURL(file) }),
  open: async (file) => {
    if (!file.url) throw new Error('This is sample data: there is no file behind it.')
    window.open(file.url, '_blank', 'noreferrer')
  },
}

export const FilesContext = createContext<FilesApi>(inPage)
export const useFiles = () => useContext(FilesContext)
