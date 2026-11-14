// Uploaded files at the edge: taking an upload, checking the files a write names, and sending a
// file back. The rules:
//
//   - A file is uploaded on its own (`POST …/files`) and belongs to nobody but its uploader until
//     a command puts it in an item's data and commits.
//   - A write may name only files the caller uploaded and no item has yet, or files the item
//     already holds. What the item's data says about a file comes from storage, never from the caller.
//   - A file is sent only to someone who can read the field it sits in, on that item, right now.

import { createHash, randomUUID } from 'node:crypto'
import { fileProblem, fileRefs, type Id, type ObjectType } from '@modus-bpm/core'
import type { AttachmentValue } from '@modus-bpm/core/model/format'
import type { FastifyReply } from 'fastify'
import type { Files, StoredFile } from './ports'

export interface FileSettings {
  /** The largest file the server takes, in megabytes. A field may ask for less. */
  maxMb: number
  /** Hours an uploaded file may wait for an item before it is deleted. */
  keepUnusedHours: number
}

export const defaultFileSettings: FileSettings = { maxMb: 25, keepUnusedHours: 24 }

/** A file's name as given, made safe to store and to send back: no path, no control characters, not endless. */
export function cleanName(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
  return clean || 'file'
}

const KIND = /^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/i

/** What the item's data holds for a stored file. */
export const valueOf = (f: StoredFile): AttachmentValue => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, sha256: f.sha256, uploadedBy: f.uploadedBy, uploadedAt: new Date(f.uploadedAt).toISOString() })

/** Store an upload. The id is the server's. */
export async function storeUpload(files: Files, appId: Id, user: Id, upload: { name?: string; kind?: string; bytes: Uint8Array }, now = Date.now()): Promise<AttachmentValue> {
  const file: StoredFile = {
    id: `f_${randomUUID()}`,
    appId,
    name: cleanName(upload.name),
    size: upload.bytes.byteLength,
    kind: upload.kind && KIND.test(upload.kind) ? upload.kind.toLowerCase() : 'application/octet-stream',
    sha256: createHash('sha256').update(upload.bytes).digest('hex'),
    uploadedBy: user,
    uploadedAt: now,
  }
  await files.put(file, upload.bytes)
  return valueOf(file)
}

export class FilesRefused extends Error {}

/**
 * Check the files a write names and replace what the caller said about each with what is stored.
 * `held` is the item's data as it stands (absent for a new item). Returns the data to write and
 * the ids of the files it names; throws FilesRefused with a message for the person.
 */
export async function takeFiles(files: Files, settings: FileSettings, appId: Id, user: Id, type: ObjectType, data: Record<string, unknown>, held?: { itemId: Id; data: Record<string, unknown> }): Promise<{ data: Record<string, unknown>; ids: Id[] }> {
  const fields = type.fields.filter((f) => f.type === 'attachment' && f.id in data)
  if (!fields.length) return { data, ids: [] }
  const out = { ...data }
  const ids: Id[] = []
  for (const field of fields) {
    const given = data[field.id]
    if (given === undefined || given === null) continue
    if (!Array.isArray(given)) throw new FilesRefused(`${field.label} is not a list of files.`)
    const before = held && Array.isArray(held.data[field.id]) ? (held.data[field.id] as AttachmentValue[]) : []
    const named = given.filter((v): v is { id: string } => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string').map((v) => v.id)
    const stored = new Map((await files.meta(appId, named)).map((f) => [f.id, f]))
    const next: AttachmentValue[] = []
    for (const v of given as Array<Partial<AttachmentValue> | null>) {
      if (!v || typeof v !== 'object') throw new FilesRefused(`${field.label} holds something that is not a file.`)
      if (typeof v.id !== 'string') {
        // A file from before files were stored (sample data): it may stay, exactly as it is.
        const same = before.find((b) => !b.id && b.name === v.name && b.size === v.size)
        if (!same) throw new FilesRefused(`${field.label}: “${String(v.name ?? 'a file')}” was not uploaded. Upload it first.`)
        next.push(same)
        continue
      }
      const file = stored.get(v.id)
      const mine = file && !file.itemId && file.uploadedBy === user
      const here = file && held && file.itemId === held.itemId && before.some((b) => b.id === file.id)
      if (!file || !(mine || here)) throw new FilesRefused(`${field.label}: “${String(v.name ?? 'a file')}” is not a file you uploaded.`)
      if (next.some((n) => n.id === file.id)) continue
      next.push(valueOf(file))
      ids.push(file.id)
    }
    // Only what this write adds is judged: a limit lowered later doesn't strand files an item already holds.
    const fresh = next.filter((n) => !before.some((b) => b.id === n.id))
    if (fresh.length) {
      if (field.maxFiles && next.length > field.maxFiles) throw new FilesRefused(`${field.label} takes at most ${field.maxFiles} file${field.maxFiles === 1 ? '' : 's'}.`)
      for (const f of fresh) {
        const problem = fileProblem(field, f, settings.maxMb)
        if (problem) throw new FilesRefused(problem)
      }
    }
    out[field.id] = next.length ? next : undefined
  }
  return { data: out, ids }
}

/** Of these files, the ones the item's data now holds. */
export const heldNow = (type: ObjectType, data: Record<string, unknown>, ids: Id[]): Id[] => {
  const now = new Set(fileRefs(type, data).map((r) => r.file.id))
  return ids.filter((id) => now.has(id))
}

/** Kinds a browser may show in place. Everything else is only ever saved to disk. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'])

/** Send a file. Never as a page: no script in an uploaded file can run with the server's origin. */
export function sendFile(reply: FastifyReply, file: StoredFile, bytes: Uint8Array, inline: boolean) {
  const show = inline && INLINE.has(file.kind)
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return reply
    .header('content-type', show ? file.kind : 'application/octet-stream')
    .header('content-disposition', `${show ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    .header('content-length', bytes.byteLength)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'private, no-store')
    .header('etag', `"${file.sha256}"`)
    .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}
