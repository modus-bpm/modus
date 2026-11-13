// Takes the picture on each template's page: the template's map as the Studio's designer draws
// it. Starts the Studio's dev server, opens it in Chrome, starts an application from each template
// (in that browser only; nothing is saved) and photographs the map at full size.
//
//   pnpm --filter @modus-bpm/template-docs capture                  # every template
//   pnpm --filter @modus-bpm/template-docs capture invoice-approval # only these pages
//
// Needs Google Chrome installed. PORT picks the dev server's port (default 5199).

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { library, PAGES, ROOT } from './library'

const port = Number(process.env.PORT ?? 5199)
const url = `http://localhost:${port}`
/** Space kept around the map, in CSS pixels. */
const MARGIN = 28
/** Device pixels per CSS pixel: sharp when a wide map is shown at page width. */
const SCALE = 1.5

async function up(): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function startStudio(): Promise<ChildProcess | undefined> {
  if (await up()) return undefined // one is already running on that port: use it
  const child = spawn('pnpm', ['--filter', '@modus-bpm/studio', 'exec', 'vite', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  for (let i = 0; i < 120; i++) {
    if (await up()) return child
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new Error(`The Studio did not start on ${url}.`)
}

const only = process.argv.slice(2)
const entries = library().filter((e) => !only.length || only.includes(e.slug))
if (!entries.length) throw new Error(`No template has a page named ${only.join(', ')}.`)

mkdirSync(`${PAGES}/images`, { recursive: true })
const studio = await startStudio()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  // Larger than any map, so every map fits at its real size.
  const page = await browser.newPage({ viewport: { width: 4200, height: 2600 }, deviceScaleFactor: SCALE })
  await page.goto(`${url}/#/studio`)
  await page.waitForSelector('.react-flow__node')
  // Only the map: no palette, zoom buttons or minimap. And at 100%, wherever the designer would have zoomed to.
  await page.addStyleTag({
    content: `.react-flow__panel, .react-flow__controls, .react-flow__minimap, .react-flow__attribution { display: none !important; }
      .react-flow__viewport { transform: translate(var(--capture-x, 0px), var(--capture-y, 0px)) scale(1) !important; }`,
  })

  for (const { template, slug } of entries) {
    // The page's own modules, so the application lands in the stores the Studio is drawing from.
    const nodes = await page.evaluate(
      async ({ root, id }) => {
        // No named helper in here: the TypeScript runner would wrap one in a function the page doesn't have.
        const core = `/@fs${root}/packages/core/src/model`
        const { seedTemplates } = await import(/* @vite-ignore */ `${core}/seed-templates.ts`)
        const { appFromTemplate } = await import(/* @vite-ignore */ `${core}/seed.ts`)
        const designStore = '/src/store/design.ts'
        const uiStore = '/src/store/ui.ts'
        const { useDesign } = await import(/* @vite-ignore */ designStore)
        const { useUi } = await import(/* @vite-ignore */ uiStore)
        const t = seedTemplates().find((x: { id: string }) => x.id === id)
        const { groups, users } = useDesign.getState().design
        const made = appFromTemplate(t, { groups, users }, t.name)
        useDesign.getState().update((d: { apps: unknown[] }) => {
          d.apps.push(made)
        })
        const ui = useUi.getState()
        ui.setApp(made.id)
        ui.setView('workflow')
        ui.setWorkflow(made.workflows[0].id)
        const at: Array<{ x: number; y: number }> = made.workflows[0].nodes.map((n: { position: { x: number; y: number } }) => n.position)
        const style = document.documentElement.style
        style.setProperty('--capture-x', `${120 - Math.min(...at.map((p) => p.x))}px`)
        style.setProperty('--capture-y', `${120 - Math.min(...at.map((p) => p.y))}px`)
        return at.length
      },
      { root: ROOT, id: template.id },
    )
    await page.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length === n, nodes)
    await page.waitForTimeout(400) // paths are measured and drawn a moment after the steps

    const box = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('.react-flow__node, .react-flow__edge-path, .react-flow__edgelabel-renderer > *')].map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height)
      const canvas = document.querySelector('.react-flow')!.getBoundingClientRect()
      return {
        left: Math.min(...rects.map((r) => r.left)),
        top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
        canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom },
      }
    })
    if (box.right + MARGIN > box.canvas.right || box.bottom + MARGIN > box.canvas.bottom) throw new Error(`${template.name}: the map is larger than the window; raise the viewport in capture.ts.`)
    const x = Math.max(box.canvas.left, box.left - MARGIN)
    const y = Math.max(box.canvas.top, box.top - MARGIN)
    await page.screenshot({ path: `${PAGES}/images/${slug}.png`, clip: { x, y, width: box.right + MARGIN - x, height: box.bottom + MARGIN - y } })
    console.log(`${slug}.png  ${Math.round(box.right - box.left)} × ${Math.round(box.bottom - box.top)}`)
  }
} finally {
  await browser.close()
  studio?.kill()
}
console.log(`Took ${entries.length} pictures into docs/templates/images.`)
