// File uploads on an item. The item's data holds a list of files per attachment field: what each
// is called, how large, what kind, and (on a server) the id of the stored bytes. The bytes
// themselves are the server's to keep (apps/server: the `Files` port); the browser simulation
// keeps a picked file only in the page.

import type { AttachmentValue } from './format'
import type { FieldDef, Id, ObjectType } from './types'

/** Megabytes a file may be when neither the field nor the server says. */
export const DEFAULT_MAX_MB = 25

const MB = 1024 * 1024

/** `Report.Final.PDF` → `pdf`; no ending → ''. */
export const fileEnding = (name: string) => (/\.([a-z0-9]{1,12})$/i.exec(name.trim())?.[1] ?? '').toLowerCase()

/** The endings a field accepts, tidied: lower case, no dots, no blanks. Empty: any file. */
export const acceptedEndings = (field: Pick<FieldDef, 'accept'>) => (field.accept ?? []).map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)

/** Why this one file can't go in the field, or undefined when it can. */
export function fileProblem(field: Pick<FieldDef, 'label' | 'accept' | 'maxMb'>, file: { name: string; size: number }, serverMaxMb?: number): string | undefined {
  const accept = acceptedEndings(field)
  if (accept.length && !accept.includes(fileEnding(file.name))) return `${field.label} takes ${accept.map((e) => `.${e}`).join(', ')} files; “${file.name}” is not one.`
  const max = Math.min(field.maxMb ?? Infinity, serverMaxMb ?? Infinity)
  if (file.size > max * MB) return `“${file.name}” is larger than ${max} MB.`
  if (file.size <= 0) return `“${file.name}” is empty.`
  return undefined
}

/** Why a field's list of files can't be saved, or undefined when it can. */
export function attachmentProblem(field: FieldDef, value: unknown, serverMaxMb?: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return `${field.label} is not a list of files.`
  if (field.maxFiles && value.length > field.maxFiles) return `${field.label} takes at most ${field.maxFiles} file${field.maxFiles === 1 ? '' : 's'}.`
  for (const f of value as AttachmentValue[]) {
    if (!f || typeof f.name !== 'string' || typeof f.size !== 'number') return `${field.label} holds something that is not a file.`
    const p = fileProblem(field, f, serverMaxMb)
    if (p) return p
  }
  return undefined
}

/** The stored files an item's data points at, with the field each is in. */
export function fileRefs(type: ObjectType, data: Record<string, unknown>): Array<{ fieldId: Id; file: AttachmentValue & { id: string } }> {
  const out: Array<{ fieldId: Id; file: AttachmentValue & { id: string } }> = []
  for (const f of type.fields) {
    if (f.type !== 'attachment' || !Array.isArray(data[f.id])) continue
    for (const file of data[f.id] as AttachmentValue[]) if (file && typeof file.id === 'string') out.push({ fieldId: f.id, file: file as AttachmentValue & { id: string } })
  }
  return out
}

const key = (f: AttachmentValue) => f.id ?? `${f.name}:${f.size}`

/** What changed between two lists of files, for the item's history: “added scan.pdf; removed draft.pdf”. */
export function describeFileChange(before: unknown, after: unknown): string {
  const a = Array.isArray(before) ? (before as AttachmentValue[]) : []
  const b = Array.isArray(after) ? (after as AttachmentValue[]) : []
  const added = b.filter((f) => !a.some((x) => key(x) === key(f))).map((f) => f.name)
  const removed = a.filter((f) => !b.some((x) => key(x) === key(f))).map((f) => f.name)
  const parts = [added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean)
  return parts.join('; ')
}
