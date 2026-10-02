/* Open tasks.
 *
 * Renders a read-only view of the tasks in a folder of notes, from a
 * code block:
 *
 *     ```open-tasks
 *     path: Projects/Tapestri Clone Caller
 *     ```
 *
 * Tasks live in the notes where they arose, one checkbox each; this
 * view only indexes them, so it holds no second copy that could
 * disagree. It replaces core-search query blocks, which show a task as
 * a raw text snippet: tags uncoloured, the regex match highlighted and
 * the ^task- block id exposed.
 *
 * Open tasks are grouped by priority tag, #p1 to #p3 as in Todoist,
 * with untagged tasks last. Each task's text is rendered as markdown,
 * so its tags are real tag elements and Pretty Properties colours them
 * through its own post-processor. The priority tag leads each row as a
 * chip, and the row's left bar takes the same colour, read from Pretty
 * Properties' tag colours. Done tasks sit in a collapsed list under a
 * progress bar.
 *
 * The view draws no checkboxes. In ai_brain a tap on a checkbox is an
 * edit to a note, and a checkbox here would be a second place to hold
 * a task's state. Each row links to the task's block id instead, or to
 * its section heading when it has no id yet.
 *
 * Tasks come from the metadata cache's listItems, which already exclude
 * code blocks, so the view never reads its own block or a query block.
 */
const {
    Component, Plugin, MarkdownRenderer, MarkdownRenderChild, TFolder,
    debounce,
} = require('obsidian');

const PRIORITY = /(^|\s)#p([1-3])\b/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const TASK_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*/;
const NAMED = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue',
    'purple', 'pink'];
// Checkbox states that close a task: done, and cancelled. Anything
// else, such as [>] forwarded or [/] partial, is still open work.
const CLOSED = new Set(['x', 'X', '-']);
const GROUPS = [
    { p: 1, label: 'Priority 1' },
    { p: 2, label: 'Priority 2' },
    { p: 3, label: 'Priority 3' },
    { p: 4, label: 'Unprioritised' },
];

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
    const p = text.match(PRIORITY);
    const priority = p ? Number(p[2]) : 4;
    if (p) text = (text.slice(0, p.index) + p[1] +
        text.slice(p.index + p[0].length)).replace(/\s{2,}/g, ' ');
    return { state: m[1], text: text.trim(), id, priority };
}

class OpenTasksView extends MarkdownRenderChild {
    constructor(plugin, el, cfg, sourcePath) {
        super(el);
        this.plugin = plugin;
        this.cfg = cfg;
        this.sourcePath = sourcePath;
        this.root = (cfg.path || folderOf(sourcePath)).replace(/\/+$/, '');
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
        const open = tasks.filter((t) => !CLOSED.has(t.state));
        const done = tasks.filter((t) => CLOSED.has(t.state));

        const head = el.createDiv({ cls: 'open-tasks-summary' });
        head.createSpan({ text: `${open.length} open, ${done.length} ` +
            `done, in ${this.root || 'the vault'}` });
        if (tasks.length) {
            const bar = el.createDiv({ cls: 'open-tasks-progress' });
            bar.createDiv({ cls: 'open-tasks-progress-done' }).style.width =
                `${(100 * done.length / tasks.length).toFixed(1)}%`;
            bar.setAttr('aria-label',
                `${done.length} of ${tasks.length} done`);
        } else {
            el.createDiv({ cls: 'open-tasks-empty',
                text: 'No tasks in these notes.' });
            return;
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

        if (done.length) {
            const det = el.createEl('details', { cls: 'open-tasks-done' });
            det.createEl('summary', { text: `Done (${done.length})` });
            const ul = det.createEl('ul', { cls: 'open-tasks-list' });
            for (const t of done) await this.row(ul, t);
        }
    }

    async row(ul, t) {
        const li = ul.createEl('li', { cls: 'open-tasks-item' });
        if (CLOSED.has(t.state)) li.addClass('is-done');
        const colour = t.priority < 4
            ? this.plugin.tagColour(`p${t.priority}`) : null;
        if (colour) li.style.setProperty('--open-tasks-bar', colour);
        const target = t.id ? `#^${t.id}`
            : t.heading ? `#${t.heading}` : '';
        const where = t.file.basename +
            (t.heading ? ` › ${t.heading}` : '');
        const chip = t.priority < 4 ? `#p${t.priority} ` : '';
        const link = `[[${t.file.path}${target}|${where}]]`;
        const md = `${chip}${t.text}\n\n${link}`;
        await MarkdownRenderer.render(this.plugin.app, md, li,
            this.sourcePath, this.pass);
        const paras = li.querySelectorAll(':scope > p');
        if (paras[0]) paras[0].addClass('open-tasks-text');
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
