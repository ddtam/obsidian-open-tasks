'use strict';
// Renders the view against a fake vault and checks what it counts.
// Run: npm test
const { JSDOM } = require('jsdom');
const Module = require('module');
const assert = require('assert');

const w = new JSDOM('<!doctype html><body></body>').window;
global.window = w;
global.document = w.document;
const P = w.HTMLElement.prototype;
function make(tag, o = {}, parent) {
    const el = w.document.createElement(tag);
    if (o.cls) el.className = o.cls;
    if (o.text !== undefined) el.textContent = o.text;
    if (parent) parent.appendChild(el);
    return el;
}
P.createDiv = function (o) { return make('div', o, this); };
P.createEl = function (t, o) { return make(t, o, this); };
P.empty = function () { while (this.firstChild) this.firstChild.remove(); };
P.addClass = function (c) { this.classList.add(c); };
P.setAttr = function (k, v) { this.setAttribute(k, v); };
global.createSpan = (o) => make('span', o);

class TFolder {}
class Component {
    addChild(c) { return c; }
    removeChild() {}
    registerEvent() {}
}
const obsidian = {
    Component, Plugin: class {}, PluginSettingTab: class {},
    Setting: class {}, Menu: class {}, Modal: class {}, Notice: class {},
    TextComponent: class {}, ButtonComponent: class {}, TFolder,
    MarkdownRenderChild: class extends Component {
        constructor(el) { super(); this.containerEl = el; }
    },
    debounce: (fn) => fn,
    MarkdownRenderer: {
        async render(app, md, el) { el.createEl('p', { text: md }); },
    },
};
const orig = Module._load;
Module._load = function (req, ...a) {
    return req === 'obsidian' ? obsidian : orig.call(this, req, ...a);
};
// package.json declares ESM, and main.js is CommonJS as Obsidian loads
// it, so it is required from a .cjs copy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-'));
fs.copyFileSync(path.join(__dirname, '..', 'main.js'),
                path.join(tmp, 'ot.cjs'));
const { OpenTasksView } = require(path.join(tmp, 'ot.cjs'));
fs.rmSync(tmp, { recursive: true });

const NOTE = [
    '- [ ] **work one** #p1 #ai ^task-a',
    '- [x] **work two** #p2 #ai ^task-b',
    '- [ ] **[[n]]: fence** #lint/fence-fold #p3 #ai ^task-lint-1',
    '- [ ] **[[n]]: chain** #lint/correction-chains #p3 #ai ^task-lint-2',
];
const file = { path: 'P/README.md', basename: 'README' };
const app = {
    vault: {
        getMarkdownFiles: () => [file],
        getAbstractFileByPath: () => new TFolder(),
        cachedRead: async () => NOTE.join('\n'),
    },
    metadataCache: {
        getFileCache: () => ({
            listItems: NOTE.map((_, i) => ({ task: ' ',
                position: { start: { line: i } } })),
            headings: [],
        }),
    },
};
const plugin = { app, settings: {}, tagColour: () => null };

async function view(lint) {
    const el = w.document.createElement('div');
    const v = new OpenTasksView(plugin, el, lint ? { lint } : {},
                                'P/TODO.md');
    v.containerEl = el;
    await v.render();
    const q = (s) => el.querySelector(s);
    return {
        summary: q('.open-tasks-summary').textContent,
        bar: q('.open-tasks-progress').getAttribute('aria-label'),
        groups: [...el.querySelectorAll('.open-tasks-group-title')]
            .map((g) => g.textContent),
        lint: q('.open-tasks-lint > summary')
            ? q('.open-tasks-lint > summary').textContent : null,
    };
}

(async () => {
    const d = await view();
    assert.match(d.summary, /^1 open, 1 done;/);
    assert.equal(d.bar, '1 of 2 done');
    assert.deepEqual(d.groups, ['Priority 1 (1)']);
    assert.equal(d.lint, 'Lint tasks (2 open), not counted above');

    const only = await view('only');
    assert.match(only.summary, /^2 open, 0 done;.*lint tasks only/);
    assert.equal(only.lint, null);

    const all = await view('include');
    assert.match(all.summary, /^3 open, 1 done;/);
    assert.equal(all.lint, null);
    console.log('open-tasks view tests: pass');
})().catch((e) => { console.error(e.message); process.exit(1); });
