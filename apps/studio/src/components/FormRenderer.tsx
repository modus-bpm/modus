import { ChevronRight, Download, EyeOff, Lock, Paperclip, Sigma, Upload, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useMemo, useRef, useState } from 'react'
import { acceptedEndings, fileProblem } from '@modus-bpm/core/model/attachments'
import { dependentFields, optionsForField } from '@modus-bpm/core/model/lists'
import { type AttachmentValue, formatBytes, formatFieldValue } from '@modus-bpm/core/model/format'
import { formPlan, type PlannedItem, type PlannedSection } from '@modus-bpm/core/model/forms'
import { isComputed, normalizeData } from '@modus-bpm/core/model/tables'
import type { FieldAccess, FieldDef, ListDef, ObjectType, User } from '@modus-bpm/core/model/types'
import { isPicked, useFiles } from './files'
import { TableField } from './TableField'
import { cx, Input, Select, Textarea, Toggle } from './ui'

// The UI is a by-product of the object type definition: this one component
// renders the create form, the step forms (with per-step field access), the
// designer preview, and the object detail view.

interface Props {
  type: ObjectType
  lists: ListDef[]
  users: User[]
  values: Record<string, unknown>
  /** Omit for a read-only rendering. */
  onChange?: (values: Record<string, unknown>) => void
  /** Per-field access for a workflow step's form. Fields not listed are editable. */
  access?: Record<string, FieldAccess>
  /** Include system fields (set by workflow steps). */
  includeSystem?: boolean
  errors?: Record<string, string>
  /** Highlight a field (used by the designer when a field is selected). */
  highlightFieldId?: string
  onFieldClick?: (fieldId: string) => void
}

export function FormRenderer({ type, lists, users, values: given, onChange, access, includeSystem, errors, highlightFieldId, onFieldClick }: Props) {
  // While editing, show totals and calculated columns current even when the caller
  // keeps only the fields the person may change (a total is never one of them).
  const values = onChange ? normalizeData(type, given) : given
  // Where everything goes: the type's layout (the forms builder's), or every field in order.
  const plan = useMemo(() => formPlan(type, { includeSystem, access }), [type, includeSystem, access])

  const setValue = (field: FieldDef, v: unknown) => {
    if (!onChange) return
    const next = { ...values, [field.id]: v }
    // Changing a parent in a linked list clears everything beneath it.
    for (const dep of dependentFields(type, field.id)) delete next[dep.id]
    // Keep computed columns and totals (Amount = sum of Line Total) current as people type.
    onChange(normalizeData(type, next))
  }

  const drawField = (item: Extract<PlannedItem, { kind: 'field' }>) => {
    const f = item.field
    const computed = isComputed(f)
    const readOnly = !onChange || access?.[f.id] === 'read' || computed
    const source = f.total ? type.fields.find((x) => x.id === f.total!.tableFieldId) : undefined
    const column = source?.columns?.find((c) => c.id === f.total!.columnId)
    return (
      <div
        key={item.id}
        onClick={onFieldClick ? () => onFieldClick(f.id) : undefined}
        style={{ '--span': item.span } as CSSProperties}
        className={cx('form-item min-w-0', onFieldClick && 'cursor-pointer rounded-md p-1.5 -m-1.5 hover:bg-slate-50', highlightFieldId === f.id && 'bg-brand-50 ring-2 ring-brand-300 hover:bg-brand-50')}
      >
        <div className="form-label mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <span>{item.label}</span>
          {f.required && !readOnly && <span className="text-rose-500">*</span>}
          {readOnly && onChange && !computed && <Lock size={11} className="text-slate-400" aria-label="Read only at this step" />}
          {computed && (
            <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 normal-case" title="Calculated: it can’t be typed in">
              <Sigma size={9} /> calculated
            </span>
          )}
          {f.system && <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 normal-case">set by workflow</span>}
        </div>
        <FieldControl field={f} type={type} lists={lists} users={users} values={values} readOnly={readOnly} error={errors?.[f.id]} placeholder={item.placeholder} onValue={(v) => setValue(f, v)} />
        {errors?.[f.id] ? (
          <p className="mt-1 text-[11px] text-rose-600">{errors[f.id]}</p>
        ) : computed && onChange ? (
          <p className="mt-1 text-[11px] leading-snug text-slate-500">
            Adds up {column?.label ?? 'a column'} across {source?.label ?? 'a table'}.
          </p>
        ) : (
          item.help && !readOnly && <p className="mt-1 text-[11px] leading-snug text-slate-500">{item.help}</p>
        )}
      </div>
    )
  }

  const draw = (item: PlannedItem) => {
    switch (item.kind) {
      case 'field':
        return drawField(item)
      case 'heading':
        return (
          <h4 key={item.id} className="form-item form-heading text-sm font-semibold text-slate-900" style={{ '--span': item.span } as CSSProperties}>
            {item.text}
          </h4>
        )
      case 'text':
        return (
          <p key={item.id} className="form-item form-text text-xs leading-relaxed whitespace-pre-wrap text-slate-600" style={{ '--span': item.span } as CSSProperties}>
            {item.text}
          </p>
        )
      case 'divider':
        return <hr key={item.id} className="form-item border-slate-200" style={{ '--span': item.span } as CSSProperties} />
      case 'image':
        return (
          <div key={item.id} className="form-item" style={{ '--span': item.span } as CSSProperties}>
            <img src={item.url} alt={item.alt} className="form-image max-w-full rounded-md object-contain" style={{ maxHeight: item.height ?? 160 }} />
          </div>
        )
    }
  }

  return (
    <div className="form">
      <div className="form-sections space-y-5">
        {plan.sections.map((s) => (
          <FormSectionView key={s.id} section={s} hasError={s.items.some((i) => i.kind === 'field' && !!errors?.[i.field.id])}>
            {s.items.map(draw)}
          </FormSectionView>
        ))}
      </div>
      {plan.hidden > 0 && (
        <p className="mt-4 flex items-center gap-1.5 text-[11px] text-slate-500">
          <EyeOff size={12} /> {plan.hidden} field{plan.hidden === 1 ? '' : 's'} hidden at this step
        </p>
      )}
    </div>
  )
}

/** One section of a form: its title, and its items on a grid that folds to one column where there is no room. */
function FormSectionView({ section, hasError, children }: { section: PlannedSection; hasError: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!section.collapsed)
  // A section with a mistake in it opens, so the message is seen.
  const shown = open || hasError
  const grid = <div className={cx('form-grid grid gap-x-4 gap-y-3.5', `form-cols-${section.columns}`)}>{children}</div>
  if (!section.title && !section.description) return <section className="form-section">{grid}</section>
  return (
    <section className="form-section">
      <div className="form-section-head mb-3">
        {section.collapsed ? (
          <button type="button" onClick={() => setOpen(!shown)} aria-expanded={shown} className="form-section-title flex w-full items-center gap-1.5 text-left text-sm font-semibold text-slate-900">
            <ChevronRight size={14} className={cx('shrink-0 text-slate-400 transition-transform', shown && 'rotate-90')} />
            {section.title ?? 'More'}
          </button>
        ) : (
          section.title && <h3 className="form-section-title text-sm font-semibold text-slate-900">{section.title}</h3>
        )}
        {section.description && shown && <p className="form-section-description mt-0.5 text-xs leading-relaxed text-slate-500">{section.description}</p>}
      </div>
      {shown && grid}
    </section>
  )
}

function FieldControl({
  field,
  type,
  lists,
  users,
  values,
  readOnly,
  error,
  placeholder,
  onValue,
}: {
  field: FieldDef
  type: ObjectType
  lists: ListDef[]
  users: User[]
  values: Record<string, unknown>
  readOnly: boolean
  error?: string
  /** Shown in an empty text, number or email field. */
  placeholder?: string
  onValue: (v: unknown) => void
}) {
  const v = values[field.id]
  if (field.type === 'table') return <TableField field={field} type={type} value={v} lists={lists} users={users} onChange={readOnly ? undefined : onValue} error={error} />
  if (readOnly) {
    if (field.type === 'attachment') return <AttachmentList files={Array.isArray(v) ? (v as AttachmentValue[]) : []} />
    const text = formatFieldValue(field, v, lists, users)
    return (
      <div
        className={cx('min-h-8 rounded-md border border-transparent bg-slate-50 px-2.5 py-1.5 text-sm', text ? 'text-slate-800' : 'text-slate-400', field.type === 'textarea' && 'whitespace-pre-wrap')}
      >
        {text || '—'}
      </div>
    )
  }
  switch (field.type) {
    case 'textarea':
      return <Textarea value={(v as string) ?? ''} placeholder={placeholder} onChange={(e) => onValue(e.target.value)} />
    case 'number':
      return <Input type="number" placeholder={placeholder} min={field.min} max={field.max} value={v === undefined ? '' : String(v)} onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))} />
    case 'currency':
      return (
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-slate-400">$</span>
          <Input
            type="number"
            step="0.01"
            min={0}
            className="pl-6 tabular-nums"
            value={v === undefined ? '' : String(v)}
            onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </div>
      )
    case 'date':
      return <Input type="date" value={(v as string) ?? ''} onChange={(e) => onValue(e.target.value || undefined)} />
    case 'boolean':
      return (
        <div className="flex h-8 items-center">
          <Toggle checked={v === true} onChange={onValue} label={<span className="text-sm text-slate-600">{v === true ? 'Yes' : 'No'}</span>} />
        </div>
      )
    case 'email':
      return <Input type="email" placeholder={placeholder} value={(v as string) ?? ''} onChange={(e) => onValue(e.target.value)} />
    case 'user':
      return (
        <Select value={(v as string) ?? ''} onChange={(e) => onValue(e.target.value || undefined)}>
          <option value="">Select a person…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} — {u.title}
            </option>
          ))}
        </Select>
      )
    case 'choice': {
      const list = lists.find((l) => l.id === field.listId)
      const options = optionsForField(field, list, values)
      const parent = field.parentFieldId ? type.fields.find((f) => f.id === field.parentFieldId) : undefined
      const waiting = parent && !values[parent.id]
      return (
        <Select value={(v as string) ?? ''} disabled={!!waiting || !list} onChange={(e) => onValue(e.target.value || undefined)}>
          <option value="">{!list ? 'No list selected' : waiting ? `Choose ${parent!.label} first` : `Select ${field.label.toLowerCase()}…`}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )
    }
    case 'attachment':
      return <AttachmentInput field={field} files={Array.isArray(v) ? (v as AttachmentValue[]) : []} onChange={onValue} />
    default:
      return <Input placeholder={placeholder} value={(v as string) ?? ''} onChange={(e) => onValue(e.target.value)} />
  }
}

function FileRow({ file, onRemove }: { file: AttachmentValue; onRemove?: () => void }) {
  const files = useFiles()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const canOpen = !!file.id || isPicked(file.url)
  const open = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await files.open(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be opened.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm">
      <div className="flex items-center gap-2">
        <Paperclip size={13} className="shrink-0 text-slate-400" />
        {canOpen ? (
          <button type="button" onClick={() => void open()} disabled={busy} className="min-w-0 truncate text-left text-brand-700 hover:underline disabled:opacity-60" title={`Open ${file.name}`}>
            {file.name}
          </button>
        ) : (
          <span className="min-w-0 truncate text-slate-700">{file.name}</span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-slate-400">{busy ? 'Opening…' : formatBytes(file.size)}</span>
        {canOpen && (
          <button type="button" aria-label={`Download ${file.name}`} onClick={() => void open()} disabled={busy} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <Download size={13} />
          </button>
        )}
        {onRemove && (
          <button type="button" aria-label={`Remove ${file.name}`} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onRemove}>
            <X size={13} />
          </button>
        )}
      </div>
      {error && (
        <p className="mt-0.5 text-[11px] text-rose-600" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

export function AttachmentList({ files }: { files: AttachmentValue[] }) {
  if (!files.length) return <div className="min-h-8 rounded-md bg-slate-50 px-2.5 py-1.5 text-sm text-slate-400">No files</div>
  return (
    <ul className="space-y-1">
      {files.map((f, i) => (
        <FileRow key={f.id ?? i} file={f} />
      ))}
    </ul>
  )
}

function AttachmentInput({ field, files, onChange }: { field: FieldDef; files: AttachmentValue[]; onChange: (v: AttachmentValue[] | undefined) => void }) {
  const store = useFiles()
  const ref = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(0)
  const [problems, setProblems] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const accept = acceptedEndings(field)
  const room = field.maxFiles ? Math.max(0, field.maxFiles - files.length) : Infinity

  const add = async (picked: File[]) => {
    if (!picked.length) return
    const said: string[] = []
    const fits = picked.filter((f) => {
      const p = fileProblem(field, f, store.maxMb)
      if (p) said.push(p)
      return !p
    })
    if (fits.length > room) said.push(`${field.label} takes at most ${field.maxFiles} file${field.maxFiles === 1 ? '' : 's'}.`)
    const taking = fits.slice(0, room)
    setProblems(said)
    if (!taking.length) return
    setUploading((n) => n + taking.length)
    const kept: AttachmentValue[] = []
    for (const f of taking) {
      try {
        kept.push(await store.upload(f))
      } catch (e) {
        said.push(`“${f.name}”: ${e instanceof Error ? e.message : 'the upload failed.'}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
    setProblems([...said])
    if (kept.length) onChange([...files, ...kept])
  }

  const limits = [accept.length && accept.map((e) => `.${e}`).join(', '), field.maxMb && `up to ${field.maxMb} MB each`, field.maxFiles && `${field.maxFiles} file${field.maxFiles === 1 ? '' : 's'} at most`].filter(Boolean).join(' · ')

  return (
    <div className="space-y-1.5">
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <FileRow
              key={f.id ?? i}
              file={f}
              onRemove={() => {
                const next = files.filter((_, j) => j !== i)
                onChange(next.length ? next : undefined)
              }}
            />
          ))}
        </ul>
      )}
      {room > 0 && (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            void add(Array.from(e.dataTransfer.files))
          }}
          disabled={uploading > 0}
          className={cx(
            'flex min-h-8 w-full items-center justify-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs font-medium disabled:cursor-wait',
            over ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-600 hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-700',
          )}
        >
          <Upload size={13} /> {uploading > 0 ? `Uploading ${uploading === 1 ? 'a file' : `${uploading} files`}…` : 'Upload a file, or drop one here'}
        </button>
      )}
      {limits && <p className="text-[11px] text-slate-500">{limits}</p>}
      {problems.map((p, i) => (
        <p key={i} className="text-[11px] text-rose-600" role="alert">
          {p}
        </p>
      ))}
      <input
        ref={ref}
        type="file"
        multiple={room > 1}
        accept={accept.length ? accept.map((e) => `.${e}`).join(',') : undefined}
        className="hidden"
        aria-label={`Files for ${field.label}`}
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </div>
  )
}
