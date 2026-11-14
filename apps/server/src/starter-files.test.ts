import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { seedTemplates } from '@modus-bpm/core/model/seed-templates'
import { STARTER_FILES } from '@modus-bpm/core/model/starter-library'
import { readTemplateFile, templateFileName, templateFileText } from '@modus-bpm/core/model/template-files'

// The starter library is the files in `templates/` at the root of the repository. This checks
// the folder against the list the product is built from (core's starter-library.ts); it lives
// here because the core has no file system to read a folder with.

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url))
const library = seedTemplates()

describe('the starter library’s files', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))

  it('holds one template in each file, named for it, and every file is in the list', () => {
    expect(files.length).toBe(STARTER_FILES.length)
    for (const f of files) {
      const read = readTemplateFile(readFileSync(`${DIR}/${f}`, 'utf8'))
      expect(read.refused, f).toEqual([])
      expect(read.templates, f).toHaveLength(1)
      expect(`${templateFileName(read.templates[0]!.name)}.json`, f).toBe(f)
      expect(library.some((t) => t.id === read.templates[0]!.id), `${f} is not listed in starter-library.ts`).toBe(true)
    }
  })

  it('are written the way an export writes them, so exporting one changes nothing', () => {
    for (const t of library) expect(readFileSync(`${DIR}/${templateFileName(t.name)}.json`, 'utf8'), t.name).toBe(templateFileText([t]))
  })
})
