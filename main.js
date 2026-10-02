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
 * Open tasks are grouped by priority. Each task's text is rendered as
 * markdown, so its tags are real tag elements and Pretty Properties
 * colours them through its own post-processor. The priority and owner
 * tags lead each row as chips, the row's left bar takes the priority
 * colour, and in-progress and deferred tasks carry a badge. Done and
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
    Component, Plugin, MarkdownRenderer, MarkdownRenderChild, TFolder,
    debounce,
} = require('obsidian');

const PRIORITY = /(^|\s)#p([1-3])\b/;
const OWNER = /(^|\s)#(human|ai)\b/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const TASK_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*/;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const NAMED = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue',
    'purple', 'pink'];

// Status from the checkbox character. Anything not listed is open,
// shown with its character as the badge.
const STATUS = {
    ' ': { open: true, badge: null },
    '/': { open: true, badge: 'in progress' },
    '>': { open: true, badge: 'deferred' },
    '-': { open: false, badge: "won't do", dropped: true },
    'x': { open: false, badge: null },
    'X': { open: false, badge: null },
};
const GROUPS = [
    { p: 1, label: 'Priority 1' },
    { p: 2, label: 'Priority 2' },
    { p: 3, label: 'Priority 3' },
    { p: 4, label: 'Unprioritised' },
];
const WEEK_MS = 7 * 24 * 3600 * 1000;

function statusOf(ch) {
    return STATUS[ch] || { open: true, badge: `[${ch}]` };
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
    const d = text.match(ISO_DATE);
    return {
        state: m[1],
        text: text.trim(),
        id,
        priority: p ? Number(p) : 4,
        owner: owner || null,
        date: d ? d[1] : null,
    };
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
                if (this.withId && !t.id) continue;
                if (this.owner && t.owner !== this.owner) continue;
                let heading = null;
                for (const h of headings) {
                    if (h.position.start.line <= n) heading = h.heading;
                    else break;
                }
                tasks.push(Object.assign(t, { file, line: n, heading }));
            }
        }
        return tasks;
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
        if (colour) li.style.setProperty('--open-tasks-bar', colour);
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
            if (status.badge) {
                const badge = createSpan({ cls: 'open-tasks-badge',
                    text: status.badge });
                paras[0].prepend(badge);
            }
        }
        if (paras[1]) paras[1].addClass('open-tasks-where');
    }
}

module.exports = class OpenTasksPlugin extends Plugin {
    onload() {
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
