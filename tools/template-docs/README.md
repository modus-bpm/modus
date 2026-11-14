# Template pages

Writes the page for each starter template in `docs/templates`, and takes the picture of its map
that the page shows.

```bash
pnpm docs:templates                                               # the pages, then the pictures
pnpm --filter @modus-bpm/template-docs pages                      # only the pages
pnpm --filter @modus-bpm/template-docs capture                    # only the pictures
pnpm --filter @modus-bpm/template-docs capture invoice-approval   # only the pictures named
```

Run it after adding or changing a template file in `templates/`, and commit what changed.

- **Pages** (`src/pages.ts`) are written from the templates themselves: the description, every
  step with what it does and where its paths lead, and the fields. It also links each name in
  `docs/TEMPLATES.md` to its page, and removes the page of a template that is gone. A new template
  still needs its row in `docs/TEMPLATES.md` by hand; the script says which.
- **Pictures** (`src/capture.ts`) are the Studio's own designer, photographed. The script starts
  the Studio's dev server, opens it in Chrome without a window, starts an application from each
  template (in that browser only; nothing is saved) and takes a picture of the map at 100%, without
  the palette, the zoom buttons or the minimap. It needs Google Chrome installed.

The pages don't edit by hand: the next run would write over the change. Change the template, or
the wording in `src/pages.ts`.
