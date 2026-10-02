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
 *             [>] deferred, [-] won't do, [x] done
 *   priority  #p1 to #p3, as in Todoist; untagged sorts last
 *   owner     #human or #ai, whoever acts next; untagged is unassigned
 *   identity  a trailing ^task-<slug> block id
 *
 * A deferred [>] task waits on the tasks it links to by block id; the
 * view says whether those are still open or all closed.
 *
 * A deferred [>] task waits on the tasks it links to by block id; the
 * view says whether those are still open or all closed.
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
 * The view draws no checkboxes. In ai_brain a tap on a checkbox is an
 * edit to a note, and a checkbox here would be a second place to hold
 * a task's state. Each row links to the task's block id instead, or to
 * its section heading when it has no id.
 *
 * Tasks come from the metadata cache's listItems, which already exclude
 * code blocks, so the view never reads its own block.
 */
const {
    Component, Plugin, PluginSettingTab, Setting, MarkdownRenderer,
    MarkdownRenderChild, TFolder, debounce,
} = require('obsidian');

// Muted by default: the priority chip already carries the colour, so a
// coloured bar on every row repeats it.
const DEFAULT_SETTINGS = { priorityBars: false };

const PRIORITY = /(^|\s)#p([1-3])\b/;
const OWNER = /(^|\s)#(human|ai)\b/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const TASK_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*/;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
// A link to another task's block id, which is how a dependency is
// written: `after [[note#^task-x|...]]`.
const TASK_LINK = /\[\[[^\]|#]*#\^(task-[A-Za-z0-9-]+)/g;
const NAMED = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue',
    'purple', 'pink'];

// Status from the checkbox character. Each draws a box whose mark
// mirrors the markdown: nothing for [ ], a slash for [/], a chevron for
// [>], a bar for [-], a tick for [x]. Anything not listed is open and
// shows its character inside the box.
const STATUS = {
    ' ': { open: true, label: 'to do', mark: null },
    '/': { open: true, label: 'in progress', mark: 'M5 11 L11 5' },
    '>': { open: true, label: 'deferred', mark: 'M6.5 5 L9.5 8 L6.5 11' },
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
    { p: 4, label: 'Unprioritised' },
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
    const after = [...text.matchAll(TASK_LINK)].map((x) => x[1]);
    return {
        state: m[1],
        text: text.trim(),
        id,
        priority: p ? Number(p) : 4,
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
        return this.root === '' || path.startsWith(this.root + '/');
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
        for (const t of tasks) {
            t.blockers = t.state !== '>' ? [] : t.after
                .map((id) => byId.get(id)).filter((b) => b && b !== t);
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
        const colour = t.priority < 4
            ? this.plugin.tagColour(`p${t.priority}`) : null;
        if (colour && this.plugin.settings.priorityBars) {
            li.style.setProperty('--open-tasks-bar', colour);
        }
        const target = t.id ? `#^${t.id}`
            : t.heading ? `#${t.heading}` : '';
        const where = t.file.basename +
            (t.heading ? ` › ${t.heading}` : '');
        const chips = (t.priority < 4 ? `#p${t.priority} ` : '') +
            (t.owner ? `#${t.owner} ` : '');
        const link = `[[${t.file.path}${target}|${where}]]`;
        await MarkdownRenderer.render(this.plugin.app,
            `${chips}${t.text}\n\n${link}`, li, this.sourcePath, this.pass);
        const paras = li.querySelectorAll(':scope > p');
        if (paras[0]) {
            paras[0].addClass('open-tasks-text');
            paras[0].prepend(statusGlyph(t.state, status));
        }
        if (paras[1]) paras[1].addClass('open-tasks-where');
        if (status.open && t.blockers.length) this.dependency(li, t);
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
