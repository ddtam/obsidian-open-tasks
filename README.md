# Open Tasks

A read-only view of the tasks in a folder of Obsidian notes, written as a code block:

````
```open-tasks
path: Projects/Tapestri Clone Caller
tasks: with-id
owner: human
```
````

Every line is optional:

- `path`: the folder to read, including subfolders. Without it, the folder of the note holding the block. `path: Projects` covers every project at once.
- `tasks: with-id`: count only checkboxes ending in a `^block-id`. Without it every checkbox counts, including checklists such as reading-path ticks.
- `owner: human` or `owner: ai`: keep only tasks with that owner tag. Without it every task is shown, each with its owner chip.

## The task line

One line carries four facts, each in one place:

```
- [/] **Add a called-fraction floor to build_clone_tree()**, ... #p2 #ai ^task-called-fraction-floor
```

| fact | written as |
|---|---|
| status | the checkbox: `[ ]` to do, `[/]` in progress, `[>]` deferred, `[-]` won't do, `[x]` done |
| priority | `#p1`, `#p2` or `#p3`, as in Todoist; untagged sorts last |
| owner | `#human` or `#ai`, whoever acts next; untagged is unassigned |
| identity | a trailing `^task-<slug>` block id |

**Status changes are dated** in the task's own text, appended rather than replacing: `Started 2026-10-02.`, `Deferred 2026-10-02 until ...`, `Done 2026-10-02: how.`, `Dropped 2026-10-02: why.` A status note sits on the task line or on an indented child line under it; the view dates a closed task by the latest ISO date across the line and its indented block.

**A deferred task waits on the tasks it links to by block id**, written `after [[note#^task-x|...]]`. The view shows `Waiting on ...` while any is open and `ready to resume` once all are closed; the deferred task's own checkbox is left for whoever resumes it. Links from tasks in any other state are references, not dependencies.

## What it shows

- A summary line: open, done and won't-do counts, and how many were done in the last 7 days, read from the latest ISO date on each done task's line or indented block.
- A progress bar of done over open plus done. Won't-do tasks count as neither, since dropping work is not progress on it.
- Open tasks grouped by priority. Each row opens with a drawn status box whose mark mirrors the checkbox (empty, slash, chevron, bar, tick), then its priority and owner tags as chips, coloured by Pretty Properties; a left bar in the priority colour is optional, off by default in the plugin's settings, since the chip already shows it. The box is an image with a label, not a checkbox, so it takes no clicks.
- Each task's text rendered as markdown, with its trailing block id hidden, and a link under it to the task's block id, or its section heading when it has none.
- Done and won't-do tasks in a collapsed list, newest first by that date, undated last. Won't-do tasks are struck through.
- `No folder at "<path>"` for a path that does not exist, rather than an empty list.

## What it does not do

- **No checkboxes.** The view never edits a note; change a task in its own note. A checkbox here would be a second place to hold a task's state.
- **No sorting beyond priority** for open tasks. Within a group they are in note order, README first, then by path, and in line order within a note, which is the order their author wrote them in.

## Conventions it assumes

The task convention is in the ai_brain vault at `Meta/Open tasks have one home, and one view per project.md`.

## Releasing

Plain JavaScript, no build step: `main.js` is committed at the root. `npm run brat:release -- <version>` bumps the manifest, commits, pushes and cuts the GitHub release BRAT installs from.
