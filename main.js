'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, MarkdownRenderChild, ItemView, Notice, setIcon, Keymap } = obsidian;
const moment = obsidian.moment || window.moment;

const VIEW_TYPE_AGENDA = 'tasknotes-agenda-view';

const DEFAULT_SETTINGS = { metaIcons: false, openInNewTab: true, showOnce: false };

// Lucide names for the meta row when icons are on. Tags are deliberately absent —
// they keep their pill background and read as labels, not as a field.
const META_ICONS = {
  due: 'calendar',
  scheduled: 'notebook-pen',
  priority: 'circle-alert',
  file: 'file-text',
};

// Fallbacks — used only if TaskNotes settings can't be read at runtime.
const DEFAULT_FIELDS = {
  title: 'title', status: 'status', priority: 'priority', due: 'due',
  scheduled: 'scheduled', completedDate: 'completedDate', projects: 'projects',
  dateCreated: 'dateCreated', dateModified: 'dateModified', archiveTag: 'archived',
  recurrence: 'recurrence', completeInstances: 'complete_instances',
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

// TaskNotes' NLP result → the task shape its API creates from. Mirrors TaskNotes'
// own mapping for its "create from text" path, so quick entry and the TaskNotes
// modal turn the same words into the same task.
function taskFromParse(p, raw) {
  const at = (d, t) => (t ? `${d}T${t}` : d);
  const task = { title: (p.title || '').trim() || raw };
  if (p.status) task.status = p.status;
  if (p.priority) task.priority = p.priority;
  if (p.dueDate) task.due = at(p.dueDate, p.dueTime);
  if (p.scheduledDate) task.scheduled = at(p.scheduledDate, p.scheduledTime);
  if (p.contexts && p.contexts.length) task.contexts = p.contexts;
  if (p.projects && p.projects.length) task.projects = p.projects;
  if (p.tags && p.tags.length) task.tags = p.tags.map((t) => String(t).replace(/^#/, ''));
  if (p.details) task.details = p.details;
  if (p.recurrence) task.recurrence = p.recurrence;
  if (p.estimate > 0) task.timeEstimate = p.estimate;
  return task;
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
    await this.loadSettings();
    this.addSettingTab(new AgendaSettingTab(this.app, this));

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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAll();
  }

  refreshAll() { this.controllers.forEach((c) => c.render()); }

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
      archiveTag: String(fields.archiveTag || 'archived').replace(/^#/, ''),
      tasksFolder: s.tasksFolder || 'TaskNotes/Tasks',
      defaultStatus: s.defaultTaskStatus || 'open',
      fields, statusMap, prioMap, doneStatus,
    };
  }

  // TaskNotes' public runtime API (plugin.api, apiVersion 1). Writes go through it
  // when it's there, so completion dates, recurrence, creation defaults and NLP all
  // behave exactly as they do inside TaskNotes. Older TaskNotes → direct frontmatter.
  tnApi() {
    const tn = this.app.plugins.plugins.tasknotes;
    const api = tn && tn.api;
    return api && api.apiVersion >= 1 && api.tasks && api.recurring ? api : null;
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
      // TaskNotes archives by adding the archive tag; the property check covers hand-edited notes.
      if (tags.has(cfg.archiveTag) || fm[F.archiveTag]) continue;
      const status = fm[F.status] || cfg.defaultStatus;
      const scheduled = normDate(fm[F.scheduled]);
      const recurring = !!fm[F.recurrence];
      // A recurring task's current occurrence is its scheduled date; TaskNotes logs each
      // completed occurrence in complete_instances and moves `scheduled` to the next one.
      const instances = Array.isArray(fm[F.completeInstances]) ? fm[F.completeInstances].map(normDate) : [];
      const instanceDone = recurring && !!scheduled && instances.includes(scheduled.slice(0, 10));
      out.push({
        file: f,
        title: fm[F.title] != null ? String(fm[F.title]) : f.basename,
        status,
        priority: fm[F.priority] || 'none',
        due: normDate(fm[F.due]),
        scheduled,
        recurring,
        instances,
        completed: normDate(fm[F.completedDate]),
        projects: linkNames(fm[F.projects]),
        tags: orderTags(tags, cfg.taskTag),
        done: instanceDone || !!(cfg.statusMap[status] && cfg.statusMap[status].isCompleted),
      });
    }
    return out;
  }

  async toggleStatus(task, cfg) {
    const api = this.tnApi();
    if (api) {
      try {
        // No date: TaskNotes resolves the occurrence itself (the scheduled one, or today
        // for completion-anchored series), which is the occurrence this row shows.
        if (task.recurring) await api.recurring.toggleCompleteInstance(task.file.path);
        else if (task.done) await api.tasks.uncomplete(task.file.path);
        else await api.tasks.complete(task.file.path);
      } catch (e) {
        console.error('[tasknotes-agenda-wrapper] status change failed', e);
        new Notice('TaskNotes could not update this task.');
      }
      return;
    }
    const F = cfg.fields;
    const nowDone = !task.done;
    await this.app.fileManager.processFrontMatter(task.file, (fm) => {
      if (task.recurring) {
        // Log the occurrence rather than closing the whole series.
        const day = (task.scheduled || moment().format('YYYY-MM-DD')).slice(0, 10);
        const list = (Array.isArray(fm[F.completeInstances]) ? fm[F.completeInstances] : []).map(normDate);
        fm[F.completeInstances] = nowDone ? [...new Set([...list, day])] : list.filter((d) => d !== day);
      } else {
        fm[F.status] = nowDone ? cfg.doneStatus : cfg.defaultStatus;
        if (nowDone) fm[F.completedDate] = moment().format('YYYY-MM-DD');
        else delete fm[F.completedDate];
      }
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

  // Click routing for task titles. A mod-click keeps Obsidian's native meaning
  // (tab / split) regardless of the setting; a plain click follows openInNewTab.
  // forceNewTab is the middle-click path — a new tab is the whole point there,
  // so it ignores the setting.
  openTask(file, evt, forceNewTab) {
    const ws = this.app.workspace;
    const mode = Keymap.isModEvent(evt);
    if (mode) { ws.getLeaf(mode).openFile(file); return; }
    if (!forceNewTab && !this.settings.openInNewTab) { ws.getLeaf(false).openFile(file); return; }
    // getLeaf('tab') always builds a new one, so repeat clicks would stack
    // duplicate tabs of the same task — surface the existing one instead.
    const open = ws.getLeavesOfType('markdown')
      .find((l) => l.view && l.view.file && l.view.file.path === file.path);
    if (open) { ws.revealLeaf(open); ws.setActiveLeaf(open, { focus: true }); return; }
    ws.getLeaf('tab').openFile(file);
  }

  async createTask(rawTitle, cfg) {
    const title = (rawTitle || '').trim();
    if (!title) return;
    const api = this.tnApi();
    if (api && typeof api.tasks.create === 'function') {
      // TaskNotes applies its own creation defaults (scheduled date, tags, folder,
      // filename format) and, with natural-language input on, parses "tomorrow 3pm #home".
      const tn = this.app.plugins.plugins.tasknotes;
      let data = { title };
      if (tn.settings && tn.settings.enableNaturalLanguageInput && api.nlp) {
        try { data = taskFromParse(api.nlp.parse(title), title); } catch (e) { /* keep the literal title */ }
      }
      try {
        await api.tasks.create(data);
        new Notice(`Task created: ${data.title}`);
      } catch (e) {
        console.error('[tasknotes-agenda-wrapper] create failed', e);
        new Notice('TaskNotes could not create this task.');
      }
      return;
    }
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
    const all = this.plugin.getTasks(cfg);
    const active = all.filter((t) => !t.done);
    const today = moment().startOf('day');
    const todayStr = today.format('YYYY-MM-DD');
    // Finished today: a completed task stamped today, or a recurring occurrence dated today.
    const doneToday = all.filter((t) => (t.done && t.completed && t.completed.slice(0, 10) === todayStr)
      || t.instances.includes(todayStr)).length;

    const past = (d) => d && moment(d, ['YYYY-MM-DD', moment.ISO_8601]).isBefore(today, 'day');
    const overdue = active.filter((t) => past(t.due));
    const unplanned = active.filter((t) => !t.due && !t.scheduled);
    // Scheduled for a day that's gone and still open: it carries into today rather than
    // falling between sections. Overdue tasks already have a home, so they stay there.
    const todoToday = active.filter((t) => this.sameDay(t.scheduled, today) || this.sameDay(t.due, today)
      || (past(t.scheduled) && !past(t.due)));

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
    if (doneToday) {
      dl.createSpan({ cls: 'fw-sep', text: '•' });
      dl.createSpan({ cls: 'fw-agenda__done', text: `${doneToday} done` });
    }
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
      // Show once: a task lands only in the first section it qualifies for; its other
      // date still reads in the meta line, so nothing is lost by dropping the repeat.
      const once = !!this.plugin.settings.showOnce;
      const shown = new Set(overdue);
      for (let i = 0; i < this.opts.days; i++) {
        const day = today.clone().add(i, 'days');
        let items = i === 0 ? todoToday : active.filter((t) => this.sameDay(t.scheduled, day) || this.sameDay(t.due, day));
        if (once) {
          items = items.filter((t) => !shown.has(t));
          items.forEach((t) => shown.add(t));
        }
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
    const titleEl = body.createDiv({ cls: 'fw-task__title', text: task.title });
    titleEl.addEventListener('click', (e) => this.plugin.openTask(task.file, e));
    // Chromium fires `auxclick`, not `click`, for the middle button, and its own
    // mousedown default starts autoscroll — so both handlers are needed.
    titleEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.plugin.openTask(task.file, e, true);
    });
    titleEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

    const meta = body.createDiv({ cls: 'fw-task__meta' });
    const icons = !!this.plugin.settings.metaIcons;
    const part = (label, val) => {
      if (val == null) return;
      if (icons && META_ICONS[label]) {
        const ic = meta.createSpan({ cls: 'fw-task__meta-icon', attr: { 'aria-label': label } });
        setIcon(ic, META_ICONS[label]);
      } else {
        meta.createSpan({ cls: 'fw-task__meta-key', text: label + ': ' });
      }
      meta.createSpan({ text: val });
      meta.createSpan({ cls: 'fw-sep', text: '·' });
    };
    // Order is fixed: scheduled (when you'll do it) before due (when it's owed).
    if (task.scheduled) part('scheduled', this.relDate(task.scheduled));
    if (task.due) part('due', this.relDate(task.due));
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

/* Settings. */
class AgendaSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Open tasks in a new tab')
      .setDesc('Clicking a task title opens it in a new tab, reusing that tab if the task is already open. Turn this off to open tasks in the current tab. Mod-click always opens a new tab either way.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.openInNewTab)
        .onChange(async (v) => {
          this.plugin.settings.openInNewTab = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Icons in task metadata')
      .setDesc('Replace the "due:" / "scheduled:" / "priority:" / "file:" labels with icons. Tags keep their pill background either way.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.metaIcons)
        .onChange(async (v) => {
          this.plugin.settings.metaIcons = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show each task once')
      .setDesc('A task scheduled for one day and due on a later one appears only on the first, with its due date still in the metadata. Off, it appears on both days, as in TaskNotes\' own agenda.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.showOnce)
        .onChange(async (v) => {
          this.plugin.settings.showOnce = v;
          await this.plugin.saveSettings();
        }));
  }
}
