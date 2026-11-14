import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { memoryStorage } from './adapters/memory'
import { cleanName } from './files'
import { buildServer } from './http'
import type { Storage } from './ports'
import { Runtime } from './runtime'

// Uploaded files through the API: an upload belongs to its uploader until an item takes it, an
// item's data says about a file what storage says, and a file is sent only to someone who can
// read the item it is on.

let storage: Storage
let rt: Runtime
let api: FastifyInstance

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  storage = memoryStorage()
  rt = await Runtime.create({ storage })
  api = buildServer(rt, { files: { maxMb: 1, keepUnusedHours: 24 } })
})

afterAll(async () => {
  await api.close()
  await rt.stop()
})

const as = (user: string) => ({ 'x-user-id': user })
const PDF = Buffer.from('%PDF-1.7 an invoice, scanned')

interface Uploaded {
  id: string
  name: string
  size: number
  kind: string
  sha256: string
  uploadedBy: string
}

async function upload(user: string, name = 'invoice.pdf', bytes: Buffer = PDF, kind = 'application/pdf') {
  return api.inject({ method: 'POST', url: `/api/apps/app_invoice/files?name=${encodeURIComponent(name)}&kind=${encodeURIComponent(kind)}`, headers: { ...as(user), 'content-type': 'application/octet-stream' }, payload: bytes })
}

const invoice = (doc: unknown, no = 'INV-F-1') => ({
  workflowId: 'w_invoice',
  data: { f_invno: no, f_vendor: 'l_vendors_0', f_lines: [{ id: 'row_1', c_desc: 'Toner', c_qty: 1, c_price: 10 }], f_dept: 'l_org_0', f_cc: 'l_org_1', f_invdate: '2026-09-28', f_doc: doc },
})

describe('uploading a file', () => {
  it('stores it and says what it is, from the bytes and not from the caller', async () => {
    const res = await upload('u_maya', '../../etc/Scan 01.PDF')
    expect(res.statusCode).toBe(201)
    const file = res.json().value as Uploaded
    expect(file).toMatchObject({ name: 'Scan 01.PDF', size: PDF.byteLength, kind: 'application/pdf', uploadedBy: 'u_maya' })
    expect(file.id).toMatch(/^f_/)
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is for people in the design, with bytes, under the size limit', async () => {
    expect((await upload('u_nobody')).statusCode).toBe(403)
    expect((await api.inject({ method: 'POST', url: '/api/apps/app_invoice/files?name=a.pdf', headers: as('u_maya'), payload: { not: 'bytes' } })).statusCode).toBe(415)
    expect((await upload('u_maya', 'empty.pdf', Buffer.alloc(0))).statusCode).toBe(400)
    const big = await upload('u_maya', 'big.pdf', Buffer.alloc(1024 * 1024 + 1))
    expect(big.statusCode).toBe(413)
    expect(big.json().error).toMatch(/1 MB/)
  })

  it('keeps a name it can store and send back', () => {
    expect(cleanName('C:\\Users\\me\\a.pdf')).toBe('a.pdf')
    expect(cleanName('a\u0000b\n.pdf')).toBe('ab.pdf')
    expect(cleanName('  ')).toBe('file')
    expect(cleanName(undefined)).toBe('file')
  })
})

describe('a file before an item takes it', () => {
  it('can be fetched by its uploader and by nobody else', async () => {
    const file = (await upload('u_maya')).json().value as Uploaded
    const mine = await api.inject({ url: `/api/apps/app_invoice/files/${file.id}`, headers: as('u_maya') })
    expect(mine.statusCode).toBe(200)
    expect(mine.rawPayload.equals(PDF)).toBe(true)
    expect((await api.inject({ url: `/api/apps/app_invoice/files/${file.id}`, headers: as('u_avery') })).statusCode).toBe(404)
  })

  it('cannot be put on an item by someone else', async () => {
    const file = (await upload('u_maya')).json().value as Uploaded
    const res = await api.inject({ method: 'POST', url: '/api/apps/app_invoice/items', headers: as('u_jordan'), payload: invoice([{ id: file.id, name: 'x', size: 1, kind: 'x/y' }], 'INV-F-2') })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/not a file you uploaded/)
  })

  it('is deleted when no item took it in time', async () => {
    const file = (await upload('u_maya')).json().value as Uploaded
    expect(await storage.files.prune(Date.now() - 60_000)).toBe(0)
    expect(await storage.files.prune(Date.now() + 60_000)).toBeGreaterThan(0)
    expect((await api.inject({ url: `/api/apps/app_invoice/files/${file.id}`, headers: as('u_maya') })).statusCode).toBe(404)
  })
})

describe('a file on an item', () => {
  let file: Uploaded
  let item: { id: string; data: Record<string, unknown> }

  beforeAll(async () => {
    file = (await upload('u_maya', 'scan.pdf')).json().value as Uploaded
    // The caller's own account of the file is not believed.
    const created = await api.inject({ method: 'POST', url: '/api/apps/app_invoice/items', headers: as('u_maya'), payload: invoice([{ id: file.id, name: 'renamed.exe', size: 5, kind: 'text/html', url: 'blob:x' }]) })
    expect(created.statusCode).toBe(201)
    item = created.json().value
  })

  it('is described in the item’s data as storage has it', () => {
    expect(item.data.f_doc).toEqual([{ id: file.id, name: 'scan.pdf', size: PDF.byteLength, kind: 'application/pdf', sha256: file.sha256, uploadedBy: 'u_maya', uploadedAt: expect.any(String) }])
  })

  it('is sent to someone who can read the item, as a download and never as a page', async () => {
    const res = await api.inject({ url: `/api/apps/app_invoice/items/${item.id}/files/${file.id}`, headers: as('u_avery') })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(PDF)).toBe(true)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="scan.pdf"/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toMatch(/sandbox/)
    const shown = await api.inject({ url: `/api/apps/app_invoice/items/${item.id}/files/${file.id}?inline=1`, headers: as('u_avery') })
    expect(shown.headers['content-type']).toBe('application/pdf')
    expect(shown.headers['content-disposition']).toMatch(/^inline/)
  })

  it('is not sent to someone who cannot read the item, nor by the uploader’s own route any more', async () => {
    expect((await api.inject({ url: `/api/apps/app_invoice/items/${item.id}/files/${file.id}`, headers: as('u_carmen') })).statusCode).toBe(404)
    expect((await api.inject({ url: `/api/apps/app_invoice/files/${file.id}`, headers: as('u_maya') })).statusCode).toBe(404)
    expect((await api.inject({ url: `/api/apps/app_invoice/items/${item.id}/files/f_unknown`, headers: as('u_avery') })).statusCode).toBe(404)
  })

  it('cannot be put on another item', async () => {
    const res = await api.inject({ method: 'POST', url: '/api/apps/app_invoice/items', headers: as('u_maya'), payload: invoice([{ id: file.id }], 'INV-F-3') })
    expect(res.statusCode).toBe(400)
  })

  it('must have been uploaded', async () => {
    const res = await api.inject({ method: 'POST', url: '/api/apps/app_invoice/items', headers: as('u_maya'), payload: invoice([{ name: 'made-up.pdf', size: 10, kind: 'application/pdf' }], 'INV-F-4') })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/was not uploaded/)
  })
})
