# Publish from the Studio to a server

Status: approved 2026-11-10, with two of the four questions decided the other way from the
recommendation: every design page saves to the server (not workflows only), and the publish
dialog's forecast runs on the server (not Simulation only). Drafts reach the server on Save, and
only administrators move items in flight, as recommended. The decisions and what they changed are
in section 7; sections 1 to 6 are written as built. Follows the Workspace on the server
([ARCHITECTURE.md](../ARCHITECTURE.md#the-studio-on-a-server-the-workspace-m3)). Second item in the
[order of work](../ROADMAP.md#next).

## Goal

A designer on a served Studio changes a workflow and the server runs it: save a draft, publish it
as a version and choose who uses it (new items, items in flight too, nobody yet), move items in
flight with the step-mapping preview, and restore an older version as the draft. All of it on the
server's live state, on PostgreSQL, with every replica picking up the change without a restart.
The server stops depending on the sample design after its first start.

## Where it stands

Everything the goal names already works in the browser, on the simulation:

- **The model.** A workflow's own nodes, edges and settings are its draft. Its `versions` are the
  numbered snapshots, and `published` is the one new items start on (`model/versions.ts`:
  `publishWorkflow`, `restoreDraft`, `draftChanges`).
- **The engine.** Items carry the version they run. `pinInFlight`, `versionUsage`, `missingSteps`
  and `migrateItems` (`engine/versions.ts`) show who runs what and move items, with a step map for
  work at steps the target version removed.
- **The Studio.** The publish dialog, history panel, step mapping and item-version control
  (`features/versions`) call those on the design in the browser's storage and on the simulation.

On the server none of it is reachable:

- The design is one JSON document (`design` table, row 1). The runtime loads it once at startup,
  or takes the sample when there is none, and never looks again. There is no route that changes it.
- Another replica is told about state commits (`ChangeNotice`), never about the design.
- A served Studio in Live shows the server's design in the Monitor and the Workspace, but its
  designer pages still edit the design kept in the browser.

So the work is plumbing and rules, not new engine behavior.

## 1. What is saved, and when

The server keeps one design document, as now. In Live the Studio's designer pages work on a copy
of it in the browser, and **Save** sends the copy back. What a save means depends on the part:

| Part of the design | When it takes effect |
| --- | --- |
| A workflow's map and settings (steps, paths, target time, field locks, supervisors, expedite policy) | Saved as the **draft**. Runs nothing: items keep the versions they are on until it is published. |
| Everything else: object types, lists, people, groups, services, templates, new applications and workflows | **At once**, as in the Studio. A new workflow starts at version 1, published, from its map. |

Nothing is sent as the designer edits: a half-drawn map shouldn't become the shared draft.
Unsaved changes show as such, and leaving with them asks first.

"Nobody yet" in the publish dialog is Save. **Restore as draft** copies an older version onto the
map in the browser, and Save makes it the server's draft. **Publish** is its own request (section
4), and the Studio saves first when there are unsaved changes.

Because the rest of the design is live the moment it is saved, the server refuses a save that
would strand work or lock people out:

- removing an application that has items, a workflow that items were created in or are running,
  or an object type that items have;
- removing a person who holds work (reassign it first);
- changing a workflow's kind or object type (make a new workflow);
- leaving the design with no administrator;
- changing anyone's roles, unless the caller is an administrator.

A workflow's versions and which one is published are the server's: a save can't add, change or
remove them, whatever the document sent says. Services keep their connection details (address,
credential name), which the server never sends out and a save can't set.

## 2. Two designers at once

The design document has a **revision**: a number that goes up by one with every write.

- A save names the revision it was made from. If the stored one is newer, the server refuses
  with 409 and changes nothing.
- The Studio then loads the newer design and carries the designer's own changes over to it, part
  by part (a workflow, an object type, a list, a person, a group, a service, a template, an
  application's own settings). Parts only the designer changed keep their changes; parts only
  someone else changed take theirs; the save is tried again. A part **both** changed is a real
  conflict: the Studio names it and asks whose to keep.

No locks and no merging inside a part.

## 3. Writes, and the other replicas

The design row is written on its own, never inside a command's transaction, so `Storage.transact`
keeps its shape. Publishing for items in flight is three steps in an order that is safe to stop
after any of them:

1. A command pins every item in flight to the version it runs now (`pinInFlight`), so items that
   started before the workflow had versions don't follow the publish.
2. The design write adds the version and makes it the published one.
3. For "items in flight too", a command moves them (`migrateItems`).

A server that dies after step 2 has published for new items only, which is a state an
administrator can choose anyway, and "move items" in History finishes the job. The other order
(items pinned to a version the design doesn't have yet) can't happen.

**Replicas.** Every design write tells listeners its revision. A replica that hears a newer one
reloads the design. That alone would leave a gap: a command arriving before the notice would run
items against a design that lacks their version. So each transaction is handed the stored
revision, and a command whose server holds an older design reloads it first. On reconnect the
design is reloaded with everything else. Migration 0006 adds `design.revision` (starting at 1)
and is compatible with the previous release.

**After the first start.** The runtime writes the sample design only when storage has none and
`seedIfEmpty` is on. From then on the stored design is the only source: it is never replaced or
patched from the sample, and with `seedIfEmpty` off an empty database starts with an empty design.

**Unversioned designs.** A design stored by an earlier release has workflows with no versions,
which run their map directly. Before the first write, each gets a version 1 made from its map as
it stands, so saving a draft never changes what runs.

Browsers learn of a design change from the event stream (`event: design`), and reload it.

## 4. Routes

| Route | Does |
| --- | --- |
| `GET /api/design` | As before, for any named user, plus `revision`. People who are neither designers nor administrators get each workflow as its published version, without the draft. |
| `PUT /api/design` `{ revision, design }` | Save: drafts for workflows, at once for the rest, under the rules in section 1. Designer or administrator. |
| `POST /api/apps/:app/workflows/:wf/publish` `{ revision, note?, who: 'new' \| 'all', stepMap? }` | Publish the saved draft as the next version. `who: 'all'` needs an administrator and answers with the migration: how many moved, and which stayed and why. |
| `GET /api/apps/:app/workflows/:wf/items` | The items in flight that run the workflow, reduced to which version each runs and where its work is (core's `versionItems`): what History, the publish dialog and the step mapping count. Designer, administrator or auditor. |
| `POST /api/apps/:app/workflows/:wf/migrate` `{ toVersion, objectIds?, stepMap? }` | Move items between versions without publishing. Administrator. |
| `POST /api/apps/:app/workflows/:wf/forecast` `{ who, stepMap?, hours }` | Run a copy of the live state forward with and without the draft published (core's `previewPublish`). Designer or administrator. |

The document a save sends is checked before anything is stored: its shape, that ids are unique,
that paths join steps that exist and workflows name an object type their application has.

## 5. The forecast

"Try it first" in the publish dialog asks the server. The server copies the application's state,
and runs the copy forward twice with **simulated people and arrivals** (the design's handling
times, outcome weights and arrival rates), once as it is and once with the draft published the way
the dialog says. Nothing is written. It answers with the same comparison the Simulation shows.
It runs in the request, so a long horizon on a large state takes a noticeable moment.

## 6. The Studio

In Live the designer pages show and edit the server's design; in Simulation, the design in the
browser, as before. One switch (the Monitor's and Workspace's Live / Simulation) decides for the
whole Studio.

- The design store holds whichever design is being edited. Entering Live puts the browser's own
  design aside (it stays in the browser's storage untouched) and loads the server's; leaving
  brings it back.
- The header shows **Save** with a count of changed parts, and "Saved" otherwise.
- The publish dialog, History, step mapping and the item-version control count items from
  `…/items` and act through the routes. Their choices and wording are unchanged.
- Until OIDC the Studio acts as the administrator chosen in the Monitor.

## 7. Decisions

1. **How much of the design is editable on a server?** Decided: every design page, live at once
   as in the Studio (recommended: workflows only, plus replacing the design from a file). This
   added the refusals in section 1 and the part-by-part carry-over in section 2, and made a
   separate "replace the whole design" route unnecessary: importing a file in Live is an edit
   like any other, saved the same way.
2. **When does a draft reach the server?** Decided as recommended: on Save.
3. **Who may do what?** Decided as recommended: designers and administrators save and publish
   for new items; only administrators move items in flight; only administrators change roles.
4. **The forecast in Live.** Decided: run it on the server (recommended: Simulation only). See
   section 5.

## 8. Tests

- Storage contract (memory and PostgreSQL): the revision goes up by one per write; a write against
  an old revision is refused and changes nothing; of several writers against one revision, one
  gets through; listeners hear each revision; a transaction is told the revision it runs under.
- Runtime, two replicas on one database: the second runs a newly published version for a new item
  without a restart, with or without having heard the notice.
- Routes: who may; conflict leaves the design as it was; a broken document is refused; each
  refusal in section 1; publish for new items leaves items in flight on their version; publish
  for all moves them and reports the skipped; drafts are hidden from people who aren't designers.
- Studio: the design source's store against a fake server (save, conflict and carry-over,
  publish, the items for the version panels).
- The live smoke check: save a draft, publish it and create an item that runs it.
