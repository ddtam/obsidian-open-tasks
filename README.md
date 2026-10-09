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
- `lint`: where tasks tagged `#lint/<name>` go. These record upkeep raised by a linter rather than the project's own work. By default (`separate`) they sit in a collapsed list of their own and are left out of the counts, the progress bar and the priority groups, so the completion rate measures the work. `lint: only` shows them alone, with their own counts; `lint: include` treats them as ordinary tasks.

## The task line

One line carries four facts, each in one place:

```
- [/] **Add a called-fraction floor to build_clone_tree()**, ... #p2 #ai ^task-called-fraction-floor
```

| fact | written as |
|---|---|
| status | the checkbox: `[ ]` to do, `[/]` in progress, `[>]` waiting, `[-]` won't do, `[x]` done |
| priority | `#p1` now, `#p2` this phase, `#p3` when convenient, `#p4` someday; always written, and an untagged task is listed under Not prioritised |
| owner | `#human` or `#ai`, whoever acts next; untagged is unassigned |
| identity | a trailing `^task-<slug>` block id |

**Status changes are recorded as child bullets**, one per change, date first, then one of six verbs, oldest first:

```
- [x] **Re-run the gate on molecules** #p2 #ai ^task-gate-molecules
    - 2026-10-01 started.
    - 2026-10-02 done: clears 4 of 22 clone pairs.
- [>] **Recover AML0051's FLT3 calls** #p3 #ai ^task-recover-aml0051-flt3
    - 2026-10-02 waiting on [[FLT3 note#^task-lost-driver-repair|the repair]].
```

The verbs are `started`, `waiting` (named `deferred` before 2026-10-03, still read), `resumed`, `handed over`, `done` and `dropped`. The task line holds only the lead, tags and id, so a status change flips the checkbox and adds a child without rewriting the line. The view dates a task by its latest status note, and a waiting task's blockers are the task links in its latest `waiting` note, in this project or another (a full-path link such as `[[Projects/Other/README#^task-x|...]]` is resolved through Obsidian's link resolution, and the view redraws when that note changes); while the view's blocker shows `Waiting on ...` or `ready to resume`, the deferred task's own checkbox is left for whoever resumes it. A task still written in the older form, with its date inline, is dated by the latest date on its line or in its block until it is migrated.

## What it shows

- A summary line: open, done and won't-do counts, and how many were done in the last 7 days, read from the latest ISO date on each done task's line or indented block.
- A progress bar of done over open plus done. Won't-do tasks count as neither, since dropping work is not progress on it.
- Open tasks grouped by priority. Each row opens with a drawn status box whose mark mirrors the checkbox (empty, slash, chevron, bar, tick), then its priority and owner tags as chips, coloured by Pretty Properties; a left bar in the priority colour is optional, off by default in the plugin's settings, since the chip already shows it. The box is an image with a label, not a checkbox, so it takes no clicks.
- Each task's text rendered as markdown, with its trailing block id hidden, and a link under it to the task's block id, or its section heading when it has none.
- Done and won't-do tasks in a collapsed list, newest first by that date, undated last. Won't-do tasks are struck through.
- `No folder at "<path>"` for a path that does not exist, rather than an empty list.

## Marking your own #human tasks

With `mark: human` in the block, or **Let me mark my #human tasks** on in the plugin's settings (off by default), an open `#human` task's status box can be clicked. The block line is the one to use where notes sync across devices, since it travels with the note while a plugin setting is per device:

- a task a session handed to you, whose latest handover note says `handed over to #human`, is **handed back**: the line is retagged `#ai` and `- <date> handed over to #ai in the task view.` is added, since the session still has work on it;
- a task that was yours from the start is **marked done**: `[x]` and `- <date> done in the task view.`

Right-click, or long-press on a phone, for: hand back with a note, done, done with a note, started, waiting (which asks until when: a date, an event, or a `^task-` link; a bare date or event is written as `until ...`), resume on a waiting task (back to in progress), and won't do (which asks for a reason). Each is one atomic write to the task's own note, followed by a notice with **Undo**. Every note the view writes ends its verb with "in the task view", so a close that records no detail reads as a click rather than as a session that skipped it. `#ai` tasks are never clickable.

## What it does not do

- **No checkboxes.** Apart from the `#human` actions above, the view never edits a note. A checkbox here would be a second place to hold a task's state.
- **No sorting beyond priority** for open tasks. Within a group they are in note order, README first, then by path, and in line order within a note, which is the order their author wrote them in.

## Conventions it assumes

The task convention is in the ai_brain vault at `Meta/Open tasks have one home, and one view per project.md`.

## Releasing

Plain JavaScript, no build step: `main.js` is committed at the root. `npm run brat:release -- <version>` bumps the manifest, commits, pushes and cuts the GitHub release BRAT installs from.
