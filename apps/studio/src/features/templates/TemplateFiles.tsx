import { useState } from 'react'
import { alreadyThere, importTemplates, NotATemplateFile, type OnExisting, readTemplateFile, templateFileName, templateFileText } from '@modus-bpm/core/model/template-files'
import type { Template } from '@modus-bpm/core/model/types'
import { plural } from '@modus-bpm/core/model/util'
import { Button, Modal } from '../../components/ui'
import { useDesign } from '../../store/design'
import { useUi } from '../../store/ui'

// Templates in and out of the library as files: one template or many in a JSON file that
// another Modus (or this one, later) can import.

/** Save these templates as one file: named for the template when there is one, for the day otherwise. */
export function downloadTemplates(templates: Template[]) {
  const name = templates.length === 1 ? templateFileName(templates[0]!.name) : `modus-templates-${new Date().toISOString().slice(0, 10)}`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([templateFileText(templates)], { type: 'application/json' }))
  a.download = `${name}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

/** What the chosen files held. */
export interface Picked {
  templates: Template[]
  /** Templates and whole files that could not be read, each with why. */
  refused: Array<{ name: string; problems: string[] }>
}

/** Read the files someone picked. A template that appears twice is taken from the first file that has it. */
export async function readPicked(files: File[]): Promise<Picked> {
  const out: Picked = { templates: [], refused: [] }
  for (const file of files) {
    try {
      const read = readTemplateFile(await file.text())
      for (const t of read.templates) {
        if (out.templates.some((x) => x.id === t.id)) out.refused.push({ name: t.name, problems: [`${file.name} holds a template another of the files already brought.`] })
        else out.templates.push(t)
      }
      out.refused.push(...read.refused)
    } catch (e) {
      out.refused.push({ name: file.name, problems: [e instanceof NotATemplateFile ? e.message : 'That file could not be read.'] })
    }
  }
  return out
}

const CHOICES: Array<{ value: OnExisting; label: string; help: string }> = [
  { value: 'copy', label: 'Keep both', help: 'The one you have stays as it is; the one from the file comes in beside it as a copy.' },
  { value: 'replace', label: 'Replace mine', help: 'The one from the file takes the place of the one you have. Workflows already made from it are not affected.' },
  { value: 'skip', label: 'Skip them', help: 'Only the templates you don’t have yet come in.' },
]

/** Confirm an import: what is coming, what can't, and what to do with the ones the library already has. */
export function ImportTemplatesModal({ picked, onClose }: { picked: Picked; onClose: () => void }) {
  const library = useDesign((s) => s.design.templates)
  const services = useDesign((s) => s.design.services)
  const update = useDesign((s) => s.update)
  const toast = useUi((s) => s.toast)
  const [onExisting, setOnExisting] = useState<OnExisting>('copy')

  const existing = alreadyThere(library, picked.templates)
  const fresh = picked.templates.length - existing.length
  const coming = onExisting === 'skip' ? fresh : picked.templates.length
  // Automated steps bound to a service this design doesn't register: the designer asks for one.
  const unbound = picked.templates.flatMap((t) => t.nodes).filter((n) => n.type === 'auto' && n.data.serviceId && !services.some((s) => s.id === n.data.serviceId)).length

  const run = () => {
    const actingAs = useUi.getState().actingAs
    const who = useDesign.getState().design.users.find((u) => u.id === actingAs)?.name
    const done = importTemplates(useDesign.getState().design.templates, picked.templates, onExisting, who)
    update((d) => {
      d.templates = done.templates
    })
    const parts = [done.added.length && `${done.added.length} added`, done.replaced.length && `${done.replaced.length} replaced`, done.copied.length && `${done.copied.length} added as copies`, done.skipped.length && `${done.skipped.length} skipped`]
    toast(`Templates imported: ${parts.filter(Boolean).join(', ') || 'nothing new'}.`, 'success')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Import templates"
      subtitle={picked.templates.length ? `${plural(picked.templates.length, 'template')} in what you chose.` : 'Nothing in what you chose can be imported.'}
      footer={
        <>
          <Button onClick={onClose}>{picked.templates.length ? 'Cancel' : 'Close'}</Button>
          {picked.templates.length > 0 && (
            <Button variant="primary" onClick={run} disabled={coming === 0}>
              {coming === 0 ? 'Nothing to import' : `Import ${plural(coming, 'template')}`}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-700">
        {picked.templates.length > 0 && (
          <ul className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs">
            {picked.templates.map((t) => (
              <li key={t.id} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{t.name}</span>
                <span className="shrink-0 text-slate-500">{existing.includes(t) ? 'already in your library' : t.category}</span>
              </li>
            ))}
          </ul>
        )}

        {existing.length > 0 && (
          <fieldset>
            <legend className="mb-1.5 text-xs font-semibold text-slate-800">
              {existing.length === 1 ? 'One of these is already in your library.' : `${existing.length} of these are already in your library.`} What should happen to {existing.length === 1 ? 'it' : 'them'}?
            </legend>
            <div className="space-y-1.5">
              {CHOICES.map((c) => (
                <label key={c.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-3 py-2 has-checked:border-brand-500 has-checked:bg-brand-50/50">
                  <input type="radio" name="on-existing" className="mt-0.5" checked={onExisting === c.value} onChange={() => setOnExisting(c.value)} />
                  <span>
                    <span className="block text-xs font-medium text-slate-900">{c.label}</span>
                    <span className="block text-xs text-slate-600">{c.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {unbound > 0 && (
          <p className="text-xs text-slate-600">
            {plural(unbound, 'automated step')} in these templates {unbound === 1 ? 'calls' : 'call'} a service this design doesn’t have. The designer will ask you to pick one when you use the template.
          </p>
        )}

        {picked.refused.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-slate-800">Can’t be imported</div>
            <ul className="space-y-1 text-xs text-slate-600">
              {picked.refused.map((r, i) => (
                <li key={i}>
                  <span className="font-medium text-slate-800">{r.name}:</span> {r.problems.slice(0, 3).join(' ')}
                  {r.problems.length > 3 && ` And ${r.problems.length - 3} more.`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
