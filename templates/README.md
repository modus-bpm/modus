# Starter templates

The fifty templates Modus ships with, one file each. They are ordinary template files: the same
JSON the Studio writes when you export a template and reads when you import one.

```json
{ "format": "modus-template", "version": 1, "templates": [{ "id": "tpl_inv", "name": "Invoice approval", "…": "…" }] }
```

What each one does, with a picture of its map, is in [docs/TEMPLATES.md](../docs/TEMPLATES.md).

## Use one

A new Modus starts with all of them in its library. To bring one into a Modus that lacks it, or
to get a starter template back after changing your copy, open **Templates** in the Studio, choose
**Import…** and pick the file. If your library already has that template, the import asks whether
to keep both, replace yours or skip it.

A Modus keeps the copies it has. A newer release that changes a file here does not change the
template in a library that already holds it; import the file if you want the new one.

## Add or change one

1. Build the workflow in the Studio's designer and choose **Workflows › Save as template**, or
   change a template you imported.
2. On the **Templates** page, export it (the download button on its card).
3. Put the file here, named for the template (`invoice-approval.json`), and list it in
   `packages/core/src/model/starter-library.ts`, where its position is its place in the gallery.
4. Run `pnpm test`. It checks that the folder and the list agree, that each file is written the
   way an export writes it, that every template is whole (nothing unreachable, every outcome has a
   path) and that sample items run to an end.
5. Run `pnpm docs:templates` to write its page and take its picture, and add its row to
   `docs/TEMPLATES.md`.

Keep ids as they are when changing a template: saved designs and imports find a template by its
id.
