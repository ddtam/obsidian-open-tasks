# Open Tasks

A read-only view of the tasks in a folder of Obsidian notes, written as a code block:

````
```open-tasks
path: Projects/Tapestri Clone Caller
```
````

`path` is a folder; without it the view covers the folder of the note holding the block.

## What it shows

- A summary line, `17 open, 5 done, in <path>`, and a progress bar of done over all tasks.
- Open tasks grouped by priority tag, `#p1` to `#p3` as in Todoist, then unprioritised. Each row leads with its priority tag as a chip, and its left bar takes the tag's colour from Pretty Properties.
- Each task's text rendered as markdown, so its tags are real tags and Pretty Properties colours them. A trailing `^block-id` is hidden.
- A link under each task to where it lives: its block id if it has one, otherwise its section heading.
- Done and cancelled tasks (`[x]`, `[X]`, `[-]`) in a collapsed list. `[>]` and `[/]` count as open.
- `No folder at "<path>"` for a path that does not exist, rather than an empty list.

## What it does not do

- **No checkboxes.** The view never edits a note; tick a task in its own note. A checkbox here would be a second place to hold a task's state.
- **No sorting beyond priority.** Within a group, tasks are in note order, README first, then by path, and in line order within a note.

## Conventions it assumes

The task convention is in the ai_brain vault at `Meta/Open tasks have one home, and a search view per project.md`: one checkbox per task, a `^task-<slug>` block id at the end of the line, and a priority tag before it.

## Releasing

Plain JavaScript, no build step: `main.js` is committed at the root. `npm run brat:release -- <version>` bumps the manifest, commits, pushes and cuts the GitHub release BRAT installs from.
