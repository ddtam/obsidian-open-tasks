/* Open tasks.
 *
 * Renders a read-only view of the tasks in a folder of notes, from a
 * code block:
 *
 *     ```open-tasks
 *     path: Projects/Tapestri Clone Caller
 *     tasks: with-id
 *     owner: human
 *     ```
 *
 * Every line is optional. `path` defaults to the folder of the note
 * holding the block. `tasks: with-id` counts only checkboxes ending in
 * a ^block-id, so a checklist (reading-path ticks, a talk checklist)
 * is not mistaken for work; without it every checkbox counts. `owner`
 * keeps only tasks tagged #human or #ai.
 *
 * Tasks live in the notes where they arose, one checkbox each, placed
 * wherever they are relevant; this view only indexes them and links
 * back into that context, so it holds no second copy that could
 * disagree.
 *
 * One line carries four facts, each in one place:
 *   status    the checkbox character: [ ] to do, [/] in progress,
 *             [>] waiting, [-] won't do, [x] done
 *   priority  #p1 to #p3, as in Todoist; untagged sorts last
 *   owner     #human or #ai, whoever acts next; untagged is unassigned
 *   identity  a trailing ^task-<slug> block id
 *
 * Each status change is a child bullet under the task, date first and
 * a fixed verb: `    - 2026-10-02 done: how.` The latest one dates the
 * task. A waiting [>] task waits on the tasks its latest `waiting`
 * note links to by block id; the view says whether those are still
 * open or all closed.
 *
 * Each status change is a child bullet under the task, date first and
 * a fixed verb: `    - 2026-10-02 done: how.` The latest one dates the
 * task. A waiting [>] task waits on the tasks its latest `waiting`
 * note links to by block id; the view says whether those are still
 * open or all closed.
 *
 * Open tasks are grouped by priority. Each task's text is rendered as
 * markdown, so its tags are real tag elements and Pretty Properties
 * colours them through its own post-processor. The priority and owner
 * tags lead each row as chips, the row's left bar takes the priority
 * colour, and a status glyph opens each row. Done and
 * won't-do tasks sit in a collapsed list, newest first by the first
 * ISO date in the line, under a progress bar that counts done tasks
 * only, since dropped work is not progress.
 *
 * The view draws no checkboxes; each row links to the task's block id,
 * or to its section heading when it has none. One exception, behind a
 * setting that is off by default: an open #human task's status box can
 * be clicked, to mark it done, or, if a session handed it to Derek,
 * to hand it back to #ai. Either writes the convention's own form in
 * the task's note, a checkbox or owner change plus a dated child note,
 * so the note stays the one home of the task's state.
 *
 * Tasks come from the metadata cache's listItems, which already exclude
 * code blocks, so the view never reads its own block.
 */
const {
    Component, Plugin, PluginSettingTab, Setting, MarkdownRenderer,
    MarkdownRenderChild, TFolder, debounce, Menu, Modal, Notice,
    TextComponent, ButtonComponent,
} = require('obsidian');

// Muted by default: the priority chip already carries the colour, so a
// coloured bar on every row repeats it.
const DEFAULT_SETTINGS = { priorityBars: false, humanTicks: false };

const PRIORITY = /(^|\s)#p([1-4])\b/;
const OWNER = /(^|\s)#(human|ai)\b/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const TASK_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*/;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
// A link to another task's block id, which is how a dependency is
// written: `after [[note#^task-x|...]]`.
const TASK_LINK = /\[\[([^\]|#]*)#\^(task-[A-Za-z0-9-]+)/g;
const NAMED = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue',
    'purple', 'pink'];

// Status from the checkbox character. Each draws a box whose mark
// mirrors the markdown: nothing for [ ], a slash for [/], a chevron for
// [>], a bar for [-], a tick for [x]. Anything not listed is open and
// shows its character inside the box.
const STATUS = {
    ' ': { open: true, label: 'to do', mark: null },
    '/': { open: true, label: 'in progress', mark: 'M5 11 L11 5' },
    '>': { open: true, label: 'waiting', mark: 'M6.5 5 L9.5 8 L6.5 11' },
    '-': { open: false, label: "won't do", mark: 'M5 8 H11',
        dropped: true },
    'x': { open: false, label: 'done', mark: 'M4.8 8.2 L7 10.4 L11.2 5.6' },
    'X': { open: false, label: 'done', mark: 'M4.8 8.2 L7 10.4 L11.2 5.6' },
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const GROUPS = [
    { p: 1, label: 'Priority 1' },
    { p: 2, label: 'Priority 2' },
    { p: 3, label: 'Priority 3' },
    { p: 4, label: 'Priority 4' },
    // No tag means not yet prioritised, since #p4 became explicit on
    // 2026-10-04; it sorts last so it stands out as a decision owed.
    { p: 5, label: 'Not prioritised' },
];
const WEEK_MS = 7 * 24 * 3600 * 1000;

function statusOf(ch) {
    return STATUS[ch] || { open: true, label: `[${ch}]`, glyph: ch };
}

function parseConfig(source) {
    const cfg = {};
    for (const line of source.split('\n')) {
        const m = line.match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
        if (m) cfg[m[1].toLowerCase()] = m[2];
    }
    return cfg;
}

function folderOf(path) {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
}

/** Remove the first match of `re` from `text`, keeping its leading space. */
function cut(text, re) {
    const m = text.match(re);
    if (!m) return [text, null];
    const rest = text.slice(0, m.index) + m[1] +
        text.slice(m.index + m[0].length);
    return [rest.replace(/\s{2,}/g, ' '), m[2]];
}

/** One task line, reduced to what the view shows. */
function parseTask(line) {
    const m = line.match(TASK_PREFIX);
    if (!m) return null;
    let text = line.slice(m[0].length);
    let id = null;
    const b = text.match(BLOCK_ID);
    if (b) {
        id = b[1];
        text = text.slice(0, b.index);
    }
    let p, owner;
    [text, p] = cut(text, PRIORITY);
    [text, owner] = cut(text, OWNER);
    // The last date on the line is the latest status note: a task that
    // reads "Started 2026-09-30. Done 2026-10-02" closed on the 2nd.
    const dates = text.match(ISO_DATE) || [];
    const after = linksIn(text);
    return {
        state: m[1],
        text: text.trim(),
        id,
        priority: p ? Number(p) : 5,
        owner: owner || null,
        date: dates.length ? dates[dates.length - 1] : null,
        after,
    };
}

/**
 * A drawn, non-interactive status box. It is an image with a label, not
 * a checkbox input, so it takes no pointer and cannot be mistaken for a
 * control: the task is changed in its own note.
 */
function statusGlyph(ch, status) {
    const wrap = createSpan({ cls: 'open-tasks-status' });
    wrap.addClass(`is-${status.label.replace(/[^a-z]+/g, '-')}`);
    wrap.setAttr('role', 'img');
    wrap.setAttr('aria-label', status.label);
    wrap.setAttr('title', status.label);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    const box = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: '2', y: '2', width: '12',
        height: '12', rx: '2.5' })) box.setAttribute(k, v);
    svg.appendChild(box);
    if (status.mark) {
        const mark = document.createElementNS(SVG_NS, 'path');
        mark.setAttribute('d', status.mark);
        mark.setAttribute('class', 'open-tasks-status-mark');
        svg.appendChild(mark);
    } else if (status.glyph) {
        const txt = document.createElementNS(SVG_NS, 'text');
        for (const [k, v] of Object.entries({ x: '8', y: '11.5',
            'text-anchor': 'middle', 'font-size': '8' })) {
            txt.setAttribute(k, v);
        }
        txt.textContent = status.glyph;
        svg.appendChild(txt);
    }
    wrap.appendChild(svg);
    return wrap;
}

// One status note: an indented child bullet, date first, then a fixed
// verb. `    - 2026-10-02 done: clears 4 of 22.`
const STATUS_NOTE = new RegExp('^\\s*(?:[-*+])\\s+(\\d{4}-\\d{2}-\\d{2})\\s+' +
    '(started|waiting|deferred|resumed|handed over|done|dropped)\\b(.*)$');

/**
 * The status notes under a task: the child bullets indented deeper than
 * it, up to the first line that is not, that match STATUS_NOTE. Returns
 * them oldest first as { date, verb, rest }, plus the latest ISO date
 * anywhere in the block, which dates a task written in the older form
 * that put the note inline or in free text.
 */
function statusNotes(lines, n) {
    const indent = (s) => s.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    const base = indent(lines[n] || '');
    const notes = [];
    let anyDate = null;
    for (let j = n + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim() || indent(l) <= base) break;
        const m = l.match(STATUS_NOTE);
        if (m) notes.push({ date: m[1], verb: m[2], rest: m[3] });
        for (const d of l.matchAll(ISO_DATE)) {
            if (!anyDate || d[1] > anyDate) anyDate = d[1];
        }
    }
    return { notes, anyDate };
}

/** Task links in `text`, as { path, id }; an empty path is this note. */
function linksIn(text) {
    return [...text.matchAll(TASK_LINK)]
        .map((x) => ({ path: x[1], id: x[2] }));
}

/**
 * Change one task's status in a note's text, the convention's way: the
 * checkbox character changes in place and one dated child note is
 * appended after the task's existing children, never rewriting them.
 * Pure, so it is tested outside Obsidian. Returns null when the task's
 * line cannot be found, so the caller writes nothing.
 */
function setStatus(data, id, ch, verb, note, date, owner) {
    const lines = data.split('\n');
    const idRe = new RegExp(`\\s\\^${id}\\s*$`);
    const n = lines.findIndex((l) => TASK_PREFIX.test(l) && idRe.test(l));
    if (n < 0) return null;
    if (ch) lines[n] = lines[n].replace(/\[(.)\]/, `[${ch}]`);
    // A handover retags the line's owner in place, beside its note.
    if (owner) {
        lines[n] = lines[n].replace(/(^|\s)#(human|ai)\b/, `$1#${owner}`);
    }
    const indentOf = (s) => s.match(/^[ \t]*/)[0];
    const width = (s) => indentOf(s).replace(/\t/g, '    ').length;
    const base = width(lines[n]);
    let last = n;
    let childIndent = indentOf(lines[n]) + '    ';
    for (let j = n + 1; j < lines.length; j++) {
        if (!lines[j].trim() || width(lines[j]) <= base) break;
        if (last === n) childIndent = indentOf(lines[j]);
        last = j;
    }
    const text = (note || '').trim().replace(/\.$/, '');
    lines.splice(last + 1, 0,
        `${childIndent}- ${date} ${verb}${text ? ': ' + text : ''}.`);
    return lines.join('\n');
}

function today() {
    // The local calendar date, as the vault's notes are dated.
    return new Date().toLocaleDateString('en-CA');
}

/** A one-line text prompt; resolves to the text, or null if cancelled. */
function askLine(app, title, placeholder, required) {
    return new Promise((resolve) => {
        const m = new Modal(app);
        let value = '';
        let done = false;
        m.titleEl.setText(title);
        const input = new TextComponent(m.contentEl)
            .setPlaceholder(placeholder)
            .onChange((v) => { value = v; });
        input.inputEl.style.width = '100%';
        const submit = () => {
            if (required && !value.trim()) return;
            done = true; m.close(); resolve(value);
        };
        input.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
        new ButtonComponent(m.contentEl).setButtonText('OK').setCta()
            .onClick(submit);
        m.onClose = () => { if (!done) resolve(null); };
        m.open();
        input.inputEl.focus();
    });
}

/** Newest first by date; undated after dated; otherwise stable. */
function byDateDesc(a, b) {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
}

class OpenTasksView extends MarkdownRenderChild {
    constructor(plugin, el, cfg, sourcePath) {
        super(el);
        this.plugin = plugin;
        this.cfg = cfg;
        this.sourcePath = sourcePath;
        this.root = (cfg.path || folderOf(sourcePath)).replace(/\/+$/, '');
        this.withId = (cfg.tasks || '').toLowerCase() === 'with-id';
        this.owner = (cfg.owner || '').toLowerCase() || null;
        this.refresh = debounce(() => this.render(), 300, true);
    }

    onload() {
        this.render();
        this.registerEvent(this.plugin.app.metadataCache.on('changed',
            (file) => { if (this.covers(file.path)) this.refresh(); }));
        this.registerEvent(this.plugin.app.vault.on('delete',
            (file) => { if (this.covers(file.path)) this.refresh(); }));
        this.registerEvent(this.plugin.app.vault.on('rename',
            (file, old) => {
                if (this.covers(file.path) || this.covers(old)) {
                    this.refresh();
                }
            }));
    }

    covers(path) {
        return this.root === '' || path.startsWith(this.root + '/') ||
            (this.external && this.external.has(path));
    }

    async collect() {
        const app = this.plugin.app;
        const files = app.vault.getMarkdownFiles()
            .filter((f) => this.covers(f.path))
            .sort((a, b) => {
                // README first, the project's front page, then by path
                const ra = a.basename === 'README' ? 0 : 1;
                const rb = b.basename === 'README' ? 0 : 1;
                return ra - rb || a.path.localeCompare(b.path);
            });
        const tasks = [];
        for (const file of files) {
            const cache = app.metadataCache.getFileCache(file);
            const items = (cache && cache.listItems || [])
                .filter((i) => i.task !== undefined);
            if (!items.length) continue;
            const lines = (await app.vault.cachedRead(file)).split('\n');
            const headings = cache.headings || [];
            for (const item of items) {
                const n = item.position.start.line;
                const t = parseTask(lines[n] || '');
                if (!t) continue;
                // A task is dated by its latest status note; a task still
                // in the older inline form falls back to the latest date
                // on its line or in its block. Blockers come from the
                // latest `deferred` note when there is one, otherwise from
                // the task line as before.
                const { notes, anyDate } = statusNotes(lines, n);
                // Whether this task reached #human by a handover from a
                // session, so finishing Derek's part hands it back.
                const ho = [...notes].reverse()
                    .find((s) => s.verb === 'handed over');
                t.handedToHuman = !!ho && /^\s*to #human\b/.test(ho.rest);
                if (notes.length) {
                    t.date = notes[notes.length - 1].date;
                    const def = [...notes].reverse()
                        // `deferred` is the verb's name before 2026-10-03.
                        .find((s) => s.verb === 'waiting' ||
                              s.verb === 'deferred');
                    if (def) {
                        t.after = linksIn(def.rest);
                    }
                } else if (anyDate && (!t.date || anyDate > t.date)) {
                    t.date = anyDate;
                }
                let heading = null;
                for (const h of headings) {
                    if (h.position.start.line <= n) heading = h.heading;
                    else break;
                }
                tasks.push(Object.assign(t, { file, line: n, heading }));
            }
        }
        // Dependencies resolve against every task in scope, before the
        // owner filter, since a #human task can wait on an #ai one.
        const byId = new Map(tasks.filter((t) => t.id)
            .map((t) => [t.id, t]));
        // Only a deferred task's links are blockers; a link from any
        // other task is a reference, so it never reads as a dependency.
        // A blocker may live in another project, written as a full-path
        // link: resolve it through Obsidian's link resolution, read its
        // line, and watch its note so a closure there redraws this view.
        this.external = new Set();
        for (const t of tasks) {
            if (t.state !== '>') continue;
            for (const a of t.after) {
                if (byId.has(a.id)) continue;
                const f = app.metadataCache.getFirstLinkpathDest(
                    a.path, t.file.path);
                if (!f) continue;
                this.external.add(f.path);
                const ls = (await app.vault.cachedRead(f)).split('\n');
                const re = new RegExp(`\\s\\^${a.id}\\s*$`);
                const i = ls.findIndex((l) => re.test(l));
                const b = i < 0 ? null : parseTask(ls[i]);
                if (b) byId.set(a.id, Object.assign(b, { file: f, line: i }));
            }
        }
        for (const t of tasks) {
            t.blockers = t.state !== '>' ? [] : t.after
                .map((a) => byId.get(a.id)).filter((b) => b && b !== t);
        }
        return tasks.filter((t) => (!this.withId || t.id) &&
            (!this.owner || t.owner === this.owner));
    }

    async render() {
        const el = this.containerEl;
        const app = this.plugin.app;
        // Each pass renders into its own child component, unloaded on the
        // next pass, so re-rendering does not accumulate children.
        if (this.pass) this.removeChild(this.pass);
        this.pass = this.addChild(new Component());
        const folder = this.root === ''
            ? app.vault.getRoot()
            : app.vault.getAbstractFileByPath(this.root);
        el.empty();
        el.addClass('open-tasks');
        if (!(folder instanceof TFolder)) {
            el.createDiv({ cls: 'open-tasks-error',
                text: `No folder at "${this.root}".` });
            return;
        }
        const tasks = await this.collect();
        const open = tasks.filter((t) => statusOf(t.state).open);
        const closed = tasks.filter((t) => !statusOf(t.state).open)
            .sort(byDateDesc);
        const dropped = closed.filter((t) => statusOf(t.state).dropped);
        const done = closed.length - dropped.length;
        const since = new Date(Date.now() - WEEK_MS)
            .toISOString().slice(0, 10);
        const recent = closed.filter((t) => !statusOf(t.state).dropped &&
            t.date && t.date >= since).length;

        const scope = [this.root || 'the vault'];
        if (this.owner) scope.push(`#${this.owner} only`);
        const parts = [`${open.length} open`, `${done} done`];
        if (dropped.length) parts.push(`${dropped.length} won't do`);
        el.createDiv({ cls: 'open-tasks-summary', text:
            `${parts.join(', ')}; ${recent} done in the last 7 days. ` +
            `In ${scope.join(', ')}.` });

        // Progress counts done tasks against open plus done: won't-do
        // tasks are neither, since dropping work is not progress on it.
        const denom = open.length + done;
        if (!tasks.length) {
            el.createDiv({ cls: 'open-tasks-empty',
                text: 'No tasks in these notes.' });
            return;
        }
        if (denom) {
            const bar = el.createDiv({ cls: 'open-tasks-progress' });
            bar.createDiv({ cls: 'open-tasks-progress-done' }).style.width =
                `${(100 * done / denom).toFixed(1)}%`;
            bar.setAttr('aria-label', `${done} of ${denom} done`);
        }

        for (const g of GROUPS) {
            const rows = open.filter((t) => t.priority === g.p);
            if (!rows.length) continue;
            const sec = el.createDiv({ cls: 'open-tasks-group' });
            sec.createDiv({ cls: 'open-tasks-group-title',
                text: `${g.label} (${rows.length})` });
            const ul = sec.createEl('ul', { cls: 'open-tasks-list' });
            for (const t of rows) await this.row(ul, t);
        }

        if (closed.length) {
            const det = el.createEl('details', { cls: 'open-tasks-done' });
            det.createEl('summary', { text: `Done and won't do ` +
                `(${closed.length}), newest first` });
            const ul = det.createEl('ul', { cls: 'open-tasks-list' });
            for (const t of closed) await this.row(ul, t);
        }
    }

    async row(ul, t) {
        const status = statusOf(t.state);
        const li = ul.createEl('li', { cls: 'open-tasks-item' });
        if (!status.open) li.addClass('is-closed');
        if (status.dropped) li.addClass('is-dropped');
        const colour = t.priority < 5
            ? this.plugin.tagColour(`p${t.priority}`) : null;
        if (colour && this.plugin.settings.priorityBars) {
            li.style.setProperty('--open-tasks-bar', colour);
        }
        const target = t.id ? `#^${t.id}`
            : t.heading ? `#${t.heading}` : '';
        const where = t.file.basename +
            (t.heading ? ` › ${t.heading}` : '');
        const chips = (t.priority < 5 ? `#p${t.priority} ` : '') +
            (t.owner ? `#${t.owner} ` : '');
        const link = `[[${t.file.path}${target}|${where}]]`;
        await MarkdownRenderer.render(this.plugin.app,
            `${chips}${t.text}\n\n${link}`, li, this.sourcePath, this.pass);
        const paras = li.querySelectorAll(':scope > p');
        if (paras[0]) {
            paras[0].addClass('open-tasks-text');
            const glyph = statusGlyph(t.state, status);
            paras[0].prepend(glyph);
            if (this.plugin.settings.humanTicks && t.owner === 'human' &&
                status.open && t.id) {
                this.actionable(glyph, t);
            }
        }
        if (paras[1]) paras[1].addClass('open-tasks-where');
        if (status.open && t.blockers.length) this.dependency(li, t);
    }

    /**
     * Derek's own #human tasks only, behind a setting that is off by
     * default: a click marks one done, and a right-click or long-press
     * offers done with a note, started, or won't do with a reason. Each
     * writes the convention's form, a checkbox change and a dated child
     * note, in one atomic write, with an Undo for a mis-tap.
     */
    actionable(glyph, t) {
        glyph.addClass('is-actionable');
        // A task a session handed to Derek goes back to #ai when his part
        // is done, since the session still has work on it; a task that
        // was his from the start is simply done.
        const back = t.handedToHuman;
        glyph.setAttr('title', `${t.state === '/' ? 'in progress' :
            'to do'}: click to ${back ? 'hand back to #ai' : 'mark done'}` +
            '; right-click for more');
        glyph.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (back) this.change(t, null, 'handed over to #ai', '', 'ai');
            else this.change(t, 'x', 'done', '');
        });
        glyph.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            const app = this.plugin.app;
            const menu = new Menu();
            menu.addItem((i) => i.setTitle('My part is done: hand back to #ai')
                .setIcon('undo-2')
                .onClick(() => this.change(t, null, 'handed over to #ai',
                                           '', 'ai')));
            menu.addItem((i) => i.setTitle('Hand back, with a note…')
                .setIcon('pencil').onClick(async () => {
                    const s = await askLine(app, 'Hand back to #ai: what ' +
                        'did you do or find?', 'briefly', false);
                    if (s !== null) {
                        this.change(t, null, 'handed over to #ai', s, 'ai');
                    }
                }));
            menu.addSeparator();
            menu.addItem((i) => i.setTitle('Done').setIcon('check')
                .onClick(() => this.change(t, 'x', 'done', '')));
            menu.addItem((i) => i.setTitle('Done, with a note…')
                .setIcon('pencil').onClick(async () => {
                    const s = await askLine(app, 'Done: how?',
                        'what was done, briefly', false);
                    if (s !== null) this.change(t, 'x', 'done', s);
                }));
            if (t.state !== '/') {
                menu.addItem((i) => i.setTitle('Started').setIcon('play')
                    .onClick(() => this.change(t, '/', 'started', '')));
            }
            menu.addItem((i) => i.setTitle('Won\'t do…').setIcon('x')
                .onClick(async () => {
                    const s = await askLine(app, 'Won\'t do: why?',
                        'the reason it is dropped', true);
                    if (s !== null) this.change(t, '-', 'dropped', s);
                }));
            menu.showAtMouseEvent(e);
        });
    }

    async change(t, ch, verb, note, owner) {
        const vault = this.plugin.app.vault;
        let before = null, after = null;
        await vault.process(t.file, (data) => {
            const next = setStatus(data, t.id, ch, verb, note, today(),
                                   owner);
            if (next === null) return data;
            before = data; after = next;
            return next;
        });
        if (after === null) {
            new Notice(`Open Tasks: could not find ^${t.id} in ` +
                `${t.file.basename}; nothing was changed.`);
            return;
        }
        const frag = createFragment((f) => {
            f.appendText(`${owner ? 'Handed back to #ai' : 'Marked ' + verb}` +
                `: ${t.file.basename}. `);
            const a = f.createEl('a', { text: 'Undo', href: '#' });
            a.addEventListener('click', async (e) => {
                e.preventDefault();
                let undone = false;
                await vault.process(t.file, (data) => {
                    if (data !== after) return data;
                    undone = true;
                    return before;
                });
                new Notice(undone ? 'Open Tasks: undone.' :
                    'Open Tasks: the note changed since; undo it by hand.');
            });
        });
        new Notice(frag, 6000);
    }

    /**
     * Computed, never stored: whether the tasks this one links to as
     * blockers are still open. The task's own status is left to whoever
     * resumes it, so "ready to resume" is a prompt, not a change.
     */
    dependency(li, t) {
        const waiting = t.blockers.filter((b) => statusOf(b.state).open);
        const el = li.createDiv({ cls: 'open-tasks-deps' });
        if (!waiting.length) {
            el.addClass('is-ready');
            el.setText(t.blockers.length === 1
                ? 'Blocker closed: ready to resume'
                : `All ${t.blockers.length} blockers closed: ready to resume`);
            return;
        }
        el.setText(`Waiting on ${waiting.length === 1 ? '' :
            `${waiting.length} tasks: `}` + waiting.map((b) =>
            b.text.replace(/\*\*/g, '').split(/[,.]/)[0].trim())
            .join('; '));
    }
}

class OpenTasksSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl)
            .setName('Priority colour bar')
            .setDesc('Draw a bar in the priority tag\'s colour beside each ' +
                'task. The priority chip shows the colour either way. ' +
                'Open views redraw when the note is next rendered.')
            .addToggle((tg) => tg
                .setValue(this.plugin.settings.priorityBars)
                .onChange(async (v) => {
                    this.plugin.settings.priorityBars = v;
                    await this.plugin.saveData(this.plugin.settings);
                }));
        new Setting(containerEl)
            .setName('Let me mark my #human tasks')
            .setDesc('Click the status box of an open #human task to mark ' +
                'it done; right-click or long-press for done with a note, ' +
                'started, or won\'t do. Each writes the checkbox and a ' +
                'dated note in the task\'s own note. Off by default; ' +
                '#ai tasks always stay read-only.')
            .addToggle((tg) => tg
                .setValue(this.plugin.settings.humanTicks)
                .onChange(async (v) => {
                    this.plugin.settings.humanTicks = v;
                    await this.plugin.saveData(this.plugin.settings);
                }));
    }
}

module.exports = class OpenTasksPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS,
            await this.loadData());
        this.addSettingTab(new OpenTasksSettingTab(this.app, this));
        this.registerMarkdownCodeBlockProcessor('open-tasks',
            (source, el, ctx) => {
                ctx.addChild(new OpenTasksView(this, el,
                    parseConfig(source), ctx.sourcePath));
            });
    }

    /**
     * A tag's colour as Pretty Properties draws it: a named colour maps
     * to the theme's variable, so it follows light and dark mode; an HSL
     * object from its colour picker is used as given. Null when Pretty
     * Properties is absent or the tag has no colour there.
     */
    tagColour(tag) {
        const pp = this.app.plugins && this.app.plugins.plugins &&
            this.app.plugins.plugins['pretty-properties'];
        const entry = pp && pp.settings && pp.settings.propertyColors &&
            pp.settings.propertyColors.tags &&
            pp.settings.propertyColors.tags[tag];
        const c = entry && entry.pillColor;
        if (!c || c === 'default' || c === 'none') return null;
        if (typeof c === 'string') {
            if (NAMED.includes(c)) return `rgb(var(--color-${c}-rgb))`;
            if (c === 'accent') return 'var(--text-accent)';
            return null;
        }
        if (typeof c.h === 'number') {
            return `hsl(${c.h}, ${c.s}%, ${c.l}%)`;
        }
        return null;
    }
};

module.exports.parseTask = parseTask;
module.exports.byDateDesc = byDateDesc;
module.exports.statusNotes = statusNotes;
module.exports.setStatus = setStatus;
