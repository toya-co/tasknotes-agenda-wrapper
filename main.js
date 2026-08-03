'use strict';

const obsidian = require('obsidian');
const { Plugin, MarkdownRenderChild, ItemView, Notice, setIcon } = obsidian;
const moment = obsidian.moment || window.moment;

const VIEW_TYPE_AGENDA = 'tasknotes-agenda-view';

// Fallbacks — used only if TaskNotes settings can't be read at runtime.
const DEFAULT_FIELDS = {
  title: 'title', status: 'status', priority: 'priority', due: 'due',
  scheduled: 'scheduled', completedDate: 'completedDate', projects: 'projects',
  dateCreated: 'dateCreated', dateModified: 'dateModified', archiveTag: 'archived',
};
const DEFAULT_STATUSES = [
  { value: 'none', label: 'None', color: '#cccccc', isCompleted: false },
  { value: 'open', label: 'Open', color: '#808080', isCompleted: false },
  { value: 'in-progress', label: 'In progress', color: '#0066cc', isCompleted: false },
  { value: 'done', label: 'Done', color: '#00aa00', isCompleted: true },
];
const DEFAULT_PRIORITIES = [
  { value: 'none', label: 'None', color: '#cccccc', weight: 0 },
  { value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
  { value: 'normal', label: 'Normal', color: '#ffaa00', weight: 2 },
  { value: 'high', label: 'High', color: '#ff0000', weight: 3 },
];

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function collectTags(fm, cache) {
  const tags = new Set();
  const add = (t) => { if (t) tags.add(String(t).replace(/^#/, '')); };
  if (fm) {
    if (Array.isArray(fm.tags)) fm.tags.forEach(add);
    else if (typeof fm.tags === 'string') fm.tags.split(/[,\s]+/).forEach(add);
  }
  if (cache && cache.tags) cache.tags.forEach((x) => add(x.tag));
  return tags;
}

// Task tag first so it stays anchored where it has always been; extra tags follow it.
function orderTags(tags, taskTag) {
  const rest = [...tags].filter((t) => t !== taskTag);
  return tags.has(taskTag) ? [taskTag, ...rest] : rest;
}

// TaskNotes stores projects as wikilinks ("[[Note]]", "[[path/Note|Alias]]") or
// markdown links; we only want the display name.
function linkText(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  const wiki = s.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki) s = wiki[1].split('|').pop();
  else {
    const md = s.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
    if (md) s = md[1] || decodeURIComponent(md[2]);
  }
  s = s.trim().split('/').pop().replace(/\.md$/i, '');
  return s || null;
}

function linkNames(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(linkText).filter(Boolean);
}

function normDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return moment(v).format('YYYY-MM-DD');
  return String(v);
}

function parseOptions(source) {
  const opts = { title: "Today's Agenda", days: 14 };
  (source || '').split('\n').forEach((line) => {
    const m = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/);
    if (!m) return;
    const k = m[1].toLowerCase();
    if (k === 'title') opts.title = m[2];
    else if (k === 'days') opts.days = Math.max(1, parseInt(m[2], 10) || 14);
  });
  return opts;
}

module.exports = class TaskNotesAgendaWrapper extends Plugin {
  async onload() {
    this.controllers = new Set();

    this.registerView(VIEW_TYPE_AGENDA, (leaf) => new AgendaPane(leaf, this));
    this.addRibbonIcon('calendar-clock', "TaskNotes agenda", () => this.activateAgenda());
    this.addCommand({ id: 'open-agenda', name: "Open Today's Agenda", callback: () => this.activateAgenda() });

    this.registerMarkdownCodeBlockProcessor('tasknotes-agenda', (source, el, ctx) => {
      ctx.addChild(new AgendaBlock(this, el, parseOptions(source)));
    });

    const refresh = debounce(() => this.controllers.forEach((c) => c.render()), 500);
    this.registerEvent(this.app.metadataCache.on('resolved', refresh));
    this.registerEvent(this.app.metadataCache.on('changed', refresh));
    this.registerEvent(this.app.vault.on('rename', refresh));
    this.registerEvent(this.app.vault.on('delete', refresh));
    this.registerInterval(window.setInterval(() => this.controllers.forEach((c) => c.render()), 5 * 60 * 1000));
  }

  async activateAgenda() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AGENDA)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_AGENDA, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  getConfig() {
    const tn = this.app.plugins.plugins.tasknotes;
    const s = (tn && tn.settings) || {};
    const fields = Object.assign({}, DEFAULT_FIELDS, s.fieldMapping || {});
    const statuses = (s.customStatuses && s.customStatuses.length) ? s.customStatuses : DEFAULT_STATUSES;
    const priorities = (s.customPriorities && s.customPriorities.length) ? s.customPriorities : DEFAULT_PRIORITIES;
    const statusMap = {}; statuses.forEach((x) => { statusMap[x.value] = x; });
    const prioMap = {}; priorities.forEach((x) => { prioMap[x.value] = x; });
    const doneStatus = (statuses.find((x) => x.isCompleted) || { value: 'done' }).value;
    return {
      taskTag: (s.taskTag || 'task').replace(/^#/, ''),
      tasksFolder: s.tasksFolder || 'TaskNotes/Tasks',
      defaultStatus: s.defaultTaskStatus || 'open',
      fields, statusMap, prioMap, doneStatus,
    };
  }

  getTasks(cfg) {
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache) continue;
      const fm = cache.frontmatter || {};
      const tags = collectTags(fm, cache);
      if (!tags.has(cfg.taskTag)) continue;
      const F = cfg.fields;
      if (fm[F.archiveTag]) continue;
      const status = fm[F.status] || cfg.defaultStatus;
      out.push({
        file: f,
        title: fm[F.title] != null ? String(fm[F.title]) : f.basename,
        status,
        priority: fm[F.priority] || 'none',
        due: normDate(fm[F.due]),
        scheduled: normDate(fm[F.scheduled]),
        projects: linkNames(fm[F.projects]),
        tags: orderTags(tags, cfg.taskTag),
        done: !!(cfg.statusMap[status] && cfg.statusMap[status].isCompleted),
      });
    }
    return out;
  }

  async toggleStatus(task, cfg) {
    const F = cfg.fields;
    const nowDone = !task.done;
    await this.app.fileManager.processFrontMatter(task.file, (fm) => {
      fm[F.status] = nowDone ? cfg.doneStatus : cfg.defaultStatus;
      if (nowDone) fm[F.completedDate] = moment().format('YYYY-MM-DD');
      else delete fm[F.completedDate];
      fm[F.dateModified] = moment().format();
    });
  }

  // Hand off to TaskNotes' own creation modal (full field editor + NLP parsing),
  // seeded with whatever was already typed. Returns false if TaskNotes isn't loaded.
  openNativeCreator(rawTitle) {
    const tn = this.app.plugins.plugins.tasknotes;
    const text = (rawTitle || '').trim();
    if (!tn || typeof tn.openTaskCreationModal !== 'function') {
      if (this.app.commands.executeCommandById('tasknotes:create-new-task')) return true;
      new Notice('TaskNotes is not available.');
      return false;
    }
    // With natural-language input on, the modal's primary field is the NL editor and
    // TaskNotes skips parsing it whenever a title is already set — so seed the editor
    // instead of prePopulatedValues.title, or "tomorrow at 3pm" would never parse.
    const nlp = !!(tn.settings && tn.settings.enableNaturalLanguageInput);
    tn.openTaskCreationModal(!nlp && text ? { title: text } : {});
    if (nlp && text) this.seedNativeCreator(text);
    return true;
  }

  // The modal builds its editor asynchronously, so poll briefly for it.
  seedNativeCreator(text, tries = 0) {
    const host = document.querySelector('.tn-task-modal__markdown-editor--nlp, .nl-input-container');
    const cm = host && host.querySelector('.cm-content');
    const plain = host && host.querySelector('input, textarea');
    if (!cm && !plain) {
      if (tries < 40) window.setTimeout(() => this.seedNativeCreator(text, tries + 1), 25);
      return;
    }
    if (plain && !cm) {
      plain.value = text;
      plain.dispatchEvent(new Event('input', { bubbles: true }));
      plain.focus();
      return;
    }
    // Preferred path: drive CodeMirror directly so its own change pipeline runs.
    const view = cm.cmView && cm.cmView.view;
    if (view && view.dispatch) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
      view.focus();
      return;
    }
    // Fallback: type it in for real, which CodeMirror picks up via beforeinput.
    cm.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }

  async createTask(rawTitle, cfg) {
    const title = (rawTitle || '').trim();
    if (!title) return;
    const folder = cfg.tasksFolder;
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    } catch (e) { /* already exists */ }
    const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, '-').slice(0, 120).trim() || 'Untitled task';
    let path = `${folder}/${safe}.md`, n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${safe} ${++n}.md`;
    const F = cfg.fields;
    const now = moment().format();
    const body = [
      '---', 'tags:', `  - ${cfg.taskTag}`,
      `${F.title}: ${JSON.stringify(title)}`,
      `${F.status}: ${cfg.defaultStatus}`,
      `${F.dateCreated}: ${now}`,
      `${F.dateModified}: ${now}`,
      '---', '',
    ].join('\n');
    await this.app.vault.create(path, body);
    new Notice(`Task created: ${title}`);
  }
};

/* Shared renderer — used by both the pane and the code block. */
class AgendaController {
  constructor(plugin, containerEl, opts) {
    this.plugin = plugin;
    this.containerEl = containerEl;
    this.opts = opts;
    this.filter = null; // null | 'todo' | 'overdue' | 'unplanned'
    this.collapsed = new Set(); // section labels the user has collapsed
  }

  relDate(dateStr) {
    const d = moment(dateStr, ['YYYY-MM-DD', moment.ISO_8601]);
    const today = moment().startOf('day');
    const diff = d.clone().startOf('day').diff(today, 'days');
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.year() === today.year() ? d.format('MMM D') : d.format('MMM D, YYYY');
  }

  sameDay(dateStr, m) {
    return dateStr && moment(dateStr, ['YYYY-MM-DD', moment.ISO_8601]).isSame(m, 'day');
  }

  empty(root, text) { root.createDiv({ cls: 'fw-agenda__empty', text }); }

  render() {
    const cfg = this.plugin.getConfig();
    const active = this.plugin.getTasks(cfg).filter((t) => !t.done);
    const today = moment().startOf('day');

    const overdue = active.filter((t) => t.due && moment(t.due, ['YYYY-MM-DD', moment.ISO_8601]).isBefore(today, 'day'));
    const unplanned = active.filter((t) => !t.due && !t.scheduled);
    const todoToday = active.filter((t) => this.sameDay(t.scheduled, today) || this.sameDay(t.due, today));

    const el = this.containerEl;
    el.empty();
    const root = el.createDiv({ cls: 'fw-agenda' });

    const now = moment();
    const dl = root.createDiv({ cls: 'fw-agenda__dateline' });
    dl.createSpan({ text: now.format('MMMM') });
    dl.createSpan({ cls: 'fw-sep', text: '•' });
    dl.createSpan({ text: now.format('D') });
    dl.createSpan({ cls: 'fw-sep', text: '•' });
    dl.createSpan({ text: now.format('YYYY') });
    root.createDiv({ cls: 'fw-agenda__title', text: this.opts.title });

    // clickable, colored stat tiles that filter the list
    const stats = root.createDiv({ cls: 'fw-agenda__stats' });
    const tile = (num, label, key) => {
      const t = stats.createDiv({ cls: `fw-stat fw-stat--${key}` + (this.filter === key ? ' is-active' : '') });
      t.createDiv({ cls: 'fw-stat__num', text: String(num) });
      t.createDiv({ cls: 'fw-stat__label', text: label });
      t.setAttribute('aria-label', `Show ${label.toLowerCase()}`);
      t.addEventListener('click', () => { this.filter = this.filter === key ? null : key; this.render(); });
    };
    tile(todoToday.length, 'Todo', 'todo');
    tile(overdue.length, 'Overdue', 'overdue');
    tile(unplanned.length, 'Unplanned', 'unplanned');

    // new-task input
    const inputWrap = root.createDiv({ cls: 'fw-agenda__input' });
    const inputHead = inputWrap.createDiv({ cls: 'fw-agenda__input-head' });
    inputHead.createDiv({ cls: 'fw-agenda__input-label', text: 'New task' });
    const advBtn = inputHead.createDiv({
      cls: 'fw-agenda__input-advanced',
      attr: { 'aria-label': 'More options — open the TaskNotes task creator' },
    });
    setIcon(advBtn, 'chevron-down');
    const inputRow = inputWrap.createDiv({ cls: 'fw-agenda__input-row' });
    const input = inputRow.createEl('input', { cls: 'fw-agenda__input-field', attr: { type: 'text', placeholder: 'Enter your task here' } });
    const submit = async () => {
      const v = input.value;
      if (!v.trim()) return;
      input.value = '';
      await this.plugin.createTask(v, cfg);
      this.render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const enterBtn = inputRow.createDiv({ cls: 'fw-agenda__input-enter', attr: { 'aria-label': 'Add task' } });
    setIcon(enterBtn, 'corner-down-left');
    enterBtn.addEventListener('click', submit);
    // Copied, not moved: cancelling the modal must not cost you the typed draft.
    // Saving instead touches the metadata cache, and that refresh rebuilds this
    // input empty — so the draft clears itself only when a task actually lands.
    advBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.openNativeCreator(input.value);
    });

    // list — filtered by the active tile, or the full agenda
    if (this.filter === 'todo') {
      todoToday.length ? this.renderSection(root, 'Today', todoToday, cfg, false) : this.empty(root, 'No tasks for today.');
    } else if (this.filter === 'overdue') {
      overdue.length ? this.renderSection(root, 'Overdue', overdue, cfg, true) : this.empty(root, 'Nothing overdue.');
    } else if (this.filter === 'unplanned') {
      unplanned.length ? this.renderSection(root, 'Unplanned', unplanned, cfg, false, true) : this.empty(root, 'No unplanned tasks.');
    } else {
      let any = false;
      if (unplanned.length) { this.renderSection(root, 'Unplanned', unplanned, cfg, false, true); any = true; }
      if (overdue.length) { this.renderSection(root, 'Overdue', overdue, cfg, true); any = true; }
      for (let i = 0; i < this.opts.days; i++) {
        const day = today.clone().add(i, 'days');
        const items = active.filter((t) => this.sameDay(t.scheduled, day) || this.sameDay(t.due, day));
        if (!items.length) continue;
        this.renderSection(root, day.format('dddd, MMM D'), items, cfg, false);
        any = true;
      }
      if (!any) this.empty(root, 'Nothing scheduled. Enjoy the quiet.');
    }
  }

  renderSection(root, label, items, cfg, isOverdue, isUnplanned) {
    const collapsed = this.collapsed.has(label);
    const head = root.createDiv({
      cls: 'fw-agenda__dayhead' + (isOverdue ? ' fw-agenda__dayhead--overdue' : '') + (isUnplanned ? ' fw-agenda__dayhead--unplanned' : '') + (collapsed ? ' is-collapsed' : ''),
    });
    const left = head.createDiv({ cls: 'fw-agenda__dayhead-left' });
    setIcon(left.createSpan({ cls: 'fw-agenda__chevron' }), 'chevron-down');
    left.createSpan({ cls: 'fw-agenda__dayhead-label', text: label });
    head.createSpan({ cls: 'fw-agenda__dayhead-count', text: String(items.length) });
    head.addEventListener('click', () => {
      if (this.collapsed.has(label)) this.collapsed.delete(label);
      else this.collapsed.add(label);
      this.render();
    });
    if (collapsed) return;
    const wt = (p) => (cfg.prioMap[p] && cfg.prioMap[p].weight) || 0;
    items.sort((a, b) => wt(b.priority) - wt(a.priority) || a.title.localeCompare(b.title));
    for (const task of items) this.renderTask(root, task, cfg);
  }

  renderTask(root, task, cfg) {
    const row = root.createDiv({ cls: 'fw-task' });
    const dots = row.createDiv({ cls: 'fw-task__dots' });
    const statusColor = (cfg.statusMap[task.status] && cfg.statusMap[task.status].color) || '#808080';
    const prioColor = (cfg.prioMap[task.priority] && cfg.prioMap[task.priority].color) || '#cccccc';
    const statusEl = dots.createDiv({ cls: 'fw-task__status' });
    statusEl.style.borderColor = statusColor;
    statusEl.setAttribute('aria-label', 'Toggle done');
    statusEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.plugin.toggleStatus(task, cfg);
      this.render();
    });
    if (task.priority && task.priority !== 'none') {
      dots.createDiv({ cls: 'fw-task__priority' }).style.background = prioColor;
    }

    const body = row.createDiv({ cls: 'fw-task__body' });
    body.createDiv({ cls: 'fw-task__title', text: task.title })
      .addEventListener('click', () => this.plugin.app.workspace.getLeaf(false).openFile(task.file));

    const meta = body.createDiv({ cls: 'fw-task__meta' });
    const part = (label, val) => {
      if (val == null) return;
      meta.createSpan({ cls: 'fw-task__meta-key', text: label + ': ' });
      meta.createSpan({ text: val });
      meta.createSpan({ cls: 'fw-sep', text: '·' });
    };
    if (task.due) part('due', this.relDate(task.due));
    if (task.scheduled) part('scheduled', this.relDate(task.scheduled));
    if (task.priority && task.priority !== 'none') {
      part('priority', (cfg.prioMap[task.priority] && cfg.prioMap[task.priority].label) || task.priority);
    }
    if (task.projects.length) part('file', task.projects.join(', '));
    for (const tag of task.tags) meta.createSpan({ cls: 'fw-task__tag', text: tag });
  }
}

/* Code-block embed (in a note). */
class AgendaBlock extends MarkdownRenderChild {
  constructor(plugin, el, opts) { super(el); this.plugin = plugin; this.opts = opts; }
  onload() {
    this.ctrl = new AgendaController(this.plugin, this.containerEl, this.opts);
    this.plugin.controllers.add(this.ctrl);
    this.ctrl.render();
  }
  onunload() { this.plugin.controllers.delete(this.ctrl); }
}

/* Workspace pane (sidebar or main). */
class AgendaPane extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE_AGENDA; }
  getDisplayText() { return "Today's Agenda"; }
  getIcon() { return 'calendar-clock'; }
  async onOpen() {
    this.contentEl.addClass('fw-agenda-view');
    this.ctrl = new AgendaController(this.plugin, this.contentEl, { title: "Today's Agenda", days: 14 });
    this.plugin.controllers.add(this.ctrl);
    this.ctrl.render();
  }
  async onClose() { if (this.ctrl) this.plugin.controllers.delete(this.ctrl); }
}
