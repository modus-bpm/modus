# Publish from the Studio to a server

Status: proposed 2026-11-10, not approved. Four questions are open (section 7); each has a
recommendation, and the rest of this document is written as if the recommendations stand.
Follows the Workspace on the server
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

The server keeps one design document, as now. Three things change it:

| Operation | What it writes | Who |
| --- | --- | --- |
| **Save draft** | One workflow's draft (nodes, edges, target time, field locks, supervisors, expedite policy). Runs nothing: items keep the versions they are on. | Designer or administrator |
| **Publish** | The draft as the next version, made the published one. With "items in flight too", also moves them (below). | Designer or administrator; moving items in flight needs an administrator |
| **Restore as draft** | The draft, replaced by an older version's snapshot. | Designer or administrator |

"Nobody yet" in the publish dialog is Save draft: it stores the draft on the server and publishes
nothing.

The Studio edits the draft in the browser as it does today and sends it when the designer presses
**Save draft** (or publishes). It does not save on every change: a half-drawn map shouldn't
become the shared draft, and one request per drag would fight other designers. Unsaved changes
show as such, and leaving with them asks first.

Everything else in the design (object types, lists, people, groups, services, templates, new
applications and workflows) is **not editable on a server in this piece** (question 1). In Live
those pages are read-only and say so. An administrator can still replace the whole design with a
file (section 5), which is how a pilot gets its own application onto a server.

## 2. Two designers at once

The design document gets a **revision**: a number that goes up by one with every write.

- Every write names the revision it was made against. If the stored one is newer, the server
  refuses with 409 and says who changed what, and the Studio reloads the design and keeps the
  designer's unsaved draft beside it so they can save again or discard.
- Writes are per workflow, so two designers on different workflows don't collide in practice:
  the server applies the workflow's change to the current document. Only two writes to the
  **same workflow** conflict.
- Each save records who and when on the workflow (`draftBy`, `draftAt`), so History can say whose
  draft it is.

No locks and no merging: a second designer on the same workflow sees the conflict and decides.

## 3. One transaction, and the other replicas

Publish with "items in flight too" changes the design and the state together: the version must
exist before items are pinned to it, and a server that crashed between the two would leave items
on a version nobody has. So the design write joins the command's transaction:

- `Storage.transact` takes an optional `design` in what the command returns, written in the same
  transaction as the state, audit entries, projections and outbox, under the application's lock.
- A design write locks the design row first, then the application: always in that order, so two
  publishes can't deadlock.
- Publish for new items only, Save draft and Restore change no state, but go the same way (an
  empty command) so there is one path and one order.
- `pinInFlight` runs before the version is added, as in the Studio, so items that started before
  a workflow had versions stay where they are.

**Replicas.** The change notice carries the design revision when a commit changed the design. A
replica that hears a newer revision than it holds reloads the design **before** it applies the
state change, in the application's queue, so no command there runs items against a design that
lacks their version. On reconnect it reloads the design with everything else. A migration adds
`design.revision` (starting at 1) and is compatible with the previous release.

**After the first start.** The runtime writes the sample design only when storage has none and
`seedIfEmpty` is on, as now. From then on the stored design is the only source: a stored design
is never replaced or patched from the sample, and a server with an empty database and
`seedIfEmpty` off starts with an empty design rather than the sample.

## 4. Routes

All under `/api/design`, all needing a designer or an administrator unless said otherwise.

| Route | Does |
| --- | --- |
| `GET /api/design` | As now, for any named user, plus `revision`. Drafts are left out for people who are neither designers nor administrators: they get each workflow as its published version. |
| `PUT /api/design/apps/:app/workflows/:wf/draft` `{ revision, draft }` | Save draft. |
| `POST …/workflows/:wf/publish` `{ revision, draft?, note, who: 'new' \| 'all', stepMap? }` | Publish (saving `draft` first when sent). `who: 'all'` needs an administrator and answers with the migration: how many moved, and which stayed and why. |
| `POST …/workflows/:wf/restore` `{ revision, version }` | Restore a version as the draft. |
| `GET …/workflows/:wf/usage?draft=` | Who runs which version, and the steps items are at that the draft (the saved one, or the one sent) doesn't have: what the step-mapping preview shows. |
| `POST …/workflows/:wf/migrate` `{ toVersion, objectIds?, stepMap? }` | Move items between versions without publishing (History's "move items", and one item from its drawer). Administrator. |
| `PUT /api/design` `{ revision, design }` | Replace the whole design. Administrator. Section 5. |

The draft is validated before it is stored: the shape (zod, from the model's types), that step and
path ids are unique and paths join steps that exist, and that it stays the same workflow (id, kind
and object type can't change here). What a design may reference (a group, a service, a field) is
checked the way the Studio already warns about it, and refused only where the engine would fail.

## 5. Replacing the whole design

`PUT /api/design` takes a design exported from a Studio. It is how a pilot's own application
reaches a server until the other design pages are editable there.

- Refused when it would remove an application that has items, or a workflow version that items
  in flight run. Those are the two ways to strand work.
- Workflows keep their version history when the incoming design has the same workflow: versions
  on the server that the file lacks are kept, never dropped.
- New applications start empty on every replica when it hears the revision.

## 6. The Studio

In Live, the designer's workflow page works on the server's design:

- The map opens on the server's draft. Edits stay in the browser until **Save draft**; a marker
  shows "unsaved changes" against the saved draft, as "draft differs from version N" does today.
- The publish dialog, History, step mapping and the item-version control read usage from the
  server and call the routes above. The dialog's choices and wording stay as they are.
- "Try a draft before publishing" (running the live state forward with and without the draft)
  stays a Simulation feature in this piece (question 4). In Live the dialog shows what changes
  and who is at removed steps, without the forecast.
- Simulation is unchanged: the design in the browser, the simulation's items.

The designer pages reuse one source for "the design being edited", the way the Workspace got one
source for its work: the browser's design in Simulation, the server's in Live.

## 7. Open questions

1. **How much of the design is editable on a server in this piece?**
   Recommended: workflows only (draft, publish, restore, migrate), plus replacing the whole design
   from a file. Object types, lists, people and groups have no draft: in the Studio a change to
   them is live at once, and on a server that means a deleted field or group changes running work
   the moment it is saved. They deserve their own rules (and people and groups mostly come from
   the identity provider once OIDC is in), so they wait.
   Alternative: every design page saves to the server, live at once as in the Studio. More useful
   for a pilot setting itself up, and the riskiest thing a designer could do to live work.

2. **When does a draft reach the server?**
   Recommended: when the designer presses Save draft (or publishes).
   Alternative: saved as they edit, a moment after each change. Nothing is ever lost, but every
   half-finished state is the shared draft and conflicts between two designers become common.

3. **Who may do what?**
   Recommended: designers and administrators save drafts, restore and publish for new items;
   only administrators move items in flight (at publish or later). Moving running work is the
   administrator's lever everywhere else in Modus.
   Alternative: designers may do all of it.

4. **The forecast in the publish dialog ("try a draft") in Live.**
   Recommended: leave it to Simulation for now. It runs the whole state forward in the browser,
   and in Live the browser holds only one person's share of the state.
   Alternative: run it on the server and send the result. More work and a heavy request.

## 8. Tests

- Core: nothing new to prove about versions and migration; one test that a draft saved, published
  and migrated through the server's operations leaves the same design and state as the same steps
  in the Studio's actions.
- Storage contract (memory and PostgreSQL): the revision goes up by one per write; a write against
  an old revision is refused and changes nothing; a design written in a command's transaction
  commits or rolls back with it.
- Runtime, two replicas on one database: the second runs a newly published version for a new item
  without a restart; hears design and state from one commit in the right order; reloads the design
  on reconnect.
- Routes: who may (designer, administrator, neither); conflict (409) leaves the design as it was;
  validation refuses a broken draft; publish for new items leaves items in flight on their
  version; publish for all moves them and reports the skipped; restore; replace refuses to strand
  work; drafts are hidden from people who aren't designers.
- Studio: the design source's store against a fake server (save, conflict and reload, publish,
  restore, usage).
- The live smoke check: publish a version through the routes and create an item that runs it.

## 9. Order of work

1. Revision, design in the command's transaction, replicas reload: storage and runtime, with tests.
2. The routes and their rules.
3. Replace the whole design.
4. The Studio's design source and the versions panels in Live.
5. Docs and the smoke check.
