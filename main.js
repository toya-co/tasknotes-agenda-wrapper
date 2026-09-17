'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, MarkdownRenderChild, ItemView, Notice, setIcon, Keymap, Menu } = obsidian;
const moment = obsidian.moment || window.moment;

const VIEW_TYPE_AGENDA = 'tasknotes-agenda-view';

const DEFAULT_SETTINGS = {
  metaIcons: false,
  openInNewTab: true,
  showCalendarEvents: false,
  hideFinishedEventsToday: false,
};

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

const GOOGLE_DEFAULT_COLOR = '#4285F4';
const MICROSOFT_DEFAULT_COLOR = '#0078D4';
const CALENDAR_SERVICE_KEYS = [
  'icsSubscriptionService',
  'googleCalendarService',
  'microsoftCalendarService',
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
    else if (k === 'events') {
      const v = m[2].trim().toLowerCase();
      opts.events = v === 'true' || v === 'yes' || v === '1';
    }
  });
  return opts;
}

function extractDateKey(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Mirrors TaskNotes MiniCalendarView.getDateKeysForExternalEvent: all-day end is exclusive.
function eventDateKeys(ev) {
  const startKey = extractDateKey(ev.start);
  if (!startKey) return [];

  const endKey = extractDateKey(ev.end || '');
  if (!endKey || endKey === startKey) return [startKey];

  const start = moment.utc(startKey, 'YYYY-MM-DD', true);
  let end = moment.utc(endKey, 'YYYY-MM-DD', true);
  if (!start.isValid() || !end.isValid()) return [startKey];

  if (ev.allDay) end = end.clone().subtract(1, 'day');
  if (end.isBefore(start, 'day')) return [startKey];

  const keys = [];
  const cursor = start.clone();
  for (let i = 0; !cursor.isAfter(end, 'day') && i < 370; i++) {
    keys.push(cursor.format('YYYY-MM-DD'));
    cursor.add(1, 'day');
  }
  return keys.length ? keys : [startKey];
}

function hasClockTime(dateStr) {
  if (!dateStr) return false;
  // YYYY-MM-DD alone is date-only; anything with a time component counts.
  return /T\d{2}:\d{2}/.test(String(dateStr)) || /\d{2}:\d{2}/.test(String(dateStr).slice(10));
}

function itemSortTime(item) {
  if (item.isEvent) {
    if (item.allDay || !hasClockTime(item.start)) return null;
    const t = moment(item.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm']);
    return t.isValid() ? t.valueOf() : null;
  }
  const raw = item.scheduled || item.due;
  if (!raw || !hasClockTime(raw)) return null;
  const t = moment(raw, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD']);
  return t.isValid() ? t.valueOf() : null;
}

function eventHasEnded(ev, now) {
  if (!ev.end) {
    if (ev.allDay || !hasClockTime(ev.start)) return false;
    const start = moment(ev.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
    if (!start.isValid()) return false;
    // No end time: assume 1h so in-progress meetings stay visible.
    return start.clone().add(1, 'hour').isBefore(now);
  }
  if (ev.allDay && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.end))) {
    // Exclusive end date: the event covers through the day before.
    const endDay = moment(ev.end, 'YYYY-MM-DD').startOf('day');
    return !endDay.isAfter(now, 'day');
  }
  const end = moment(ev.end, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD']);
  return end.isValid() && end.isBefore(now);
}

function findProviderCalendar(calendars, id) {
  if (!calendars || !id) return null;
  if (Array.isArray(calendars)) {
    return calendars.find((c) => c && (c.id === id || c.calendarId === id)) || null;
  }
  if (typeof calendars.get === 'function') return calendars.get(id) || null;
  return calendars[id] || null;
}

function calendarLabel(cal, fallback) {
  if (!cal) return fallback;
  return cal.summary || cal.name || cal.displayName || fallback;
}

function calendarColor(cal, fallback) {
  if (!cal) return fallback;
  return cal.backgroundColor || cal.color || cal.hexColor || fallback;
}

function calendarIsEnabled(cal) {
  if (!cal) return true;
  if (cal.enabled === false || cal.selected === false || cal.hidden === true) return false;
  return true;
}

module.exports = class TaskNotesAgendaWrapper extends Plugin {
  async onload() {
    this.controllers = new Set();
    this._calendarUnsubs = [];
    this._calendarSubscribed = new Set();
    await this.loadSettings();
    this.addSettingTab(new AgendaSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_AGENDA, (leaf) => new AgendaPane(leaf, this));
    this.addRibbonIcon('calendar-clock', "TaskNotes agenda", () => this.activateAgenda());
    this.addCommand({ id: 'open-agenda', name: "Open Today's Agenda", callback: () => this.activateAgenda() });

    this.registerMarkdownCodeBlockProcessor('tasknotes-agenda', (source, el, ctx) => {
      ctx.addChild(new AgendaBlock(this, el, parseOptions(source)));
    });

    this._refresh = debounce(() => this.controllers.forEach((c) => c.render()), 500);
    this.registerEvent(this.app.metadataCache.on('resolved', this._refresh));
    this.registerEvent(this.app.metadataCache.on('changed', this._refresh));
    this.registerEvent(this.app.vault.on('rename', this._refresh));
    this.registerEvent(this.app.vault.on('delete', this._refresh));
    this.registerInterval(window.setInterval(() => this.controllers.forEach((c) => c.render()), 5 * 60 * 1000));

    this.app.workspace.onLayoutReady(() => this.subscribeCalendarServices());
    // Safety net if TaskNotes loads after us — also re-tried from render().
    this.register(() => this.unsubscribeCalendarServices());
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

  getTaskNotes() {
    return this.app.plugins.plugins.tasknotes || null;
  }

  hasCalendarIntegration() {
    const tn = this.getTaskNotes();
    if (!tn) return false;
    return CALENDAR_SERVICE_KEYS.some((k) => tn[k] && typeof tn[k].getAllEvents === 'function');
  }

  subscribeCalendarServices() {
    const tn = this.getTaskNotes();
    if (!tn) return;
    for (const key of CALENDAR_SERVICE_KEYS) {
      if (this._calendarSubscribed.has(key)) continue;
      const svc = tn[key];
      if (!svc || typeof svc.on !== 'function') continue;
      try {
        const unsub = svc.on('data-changed', this._refresh);
        if (typeof unsub === 'function') this._calendarUnsubs.push(unsub);
        this._calendarSubscribed.add(key);
      } catch (e) { /* internal emitter — never break the agenda */ }
    }
  }

  unsubscribeCalendarServices() {
    for (const unsub of this._calendarUnsubs) {
      try { unsub(); } catch (e) { /* ignore */ }
    }
    this._calendarUnsubs = [];
    this._calendarSubscribed = new Set();
  }

  getConfig() {
    const tn = this.getTaskNotes();
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

  getCalendarEvents() {
    const tn = this.getTaskNotes();
    if (!tn) return [];
    // TaskNotes may finish booting after us — keep trying to attach listeners.
    this.subscribeCalendarServices();

    const out = [];
    const seen = new Set();
    const push = (list, resolveMeta) => {
      for (const ev of list || []) {
        if (!ev) continue;
        const id = ev.id || `${ev.subscriptionId || 'cal'}:${ev.start || ''}:${ev.title || ''}`;
        if (!id || seen.has(id)) continue;
        let meta;
        try { meta = resolveMeta(ev); } catch (e) { continue; }
        if (!meta) continue;
        seen.add(id);
        out.push(Object.assign({}, ev, meta, { isEvent: true, id }));
      }
    };

    const ics = tn.icsSubscriptionService;
    if (ics && typeof ics.getAllEvents === 'function') {
      try {
        const subs = new Map();
        if (typeof ics.getSubscriptions === 'function') {
          for (const s of ics.getSubscriptions() || []) {
            if (s && s.id) subs.set(s.id, s);
          }
        }
        push(ics.getAllEvents(), (ev) => {
          const sub = subs.get(ev.subscriptionId);
          if (sub && sub.enabled === false) return null;
          return {
            calendarName: (sub && sub.name) || 'Calendar',
            color: ev.color || (sub && sub.color) || '#7aa2f7',
          };
        });
      } catch (e) { /* never break the agenda */ }
    }

    const google = tn.googleCalendarService;
    if (google && typeof google.getAllEvents === 'function') {
      try {
        const calendars = typeof google.getAvailableCalendars === 'function'
          ? google.getAvailableCalendars()
          : [];
        push(google.getAllEvents(), (ev) => {
          const calId = String(ev.subscriptionId || '').replace(/^google-/, '');
          const cal = findProviderCalendar(calendars, calId);
          if (!calendarIsEnabled(cal)) return null;
          return {
            calendarName: calendarLabel(cal, 'Google Calendar'),
            color: ev.color || calendarColor(cal, GOOGLE_DEFAULT_COLOR),
          };
        });
      } catch (e) { /* never break the agenda */ }
    }

    const ms = tn.microsoftCalendarService;
    if (ms && typeof ms.getAllEvents === 'function') {
      try {
        const calendars = typeof ms.getAvailableCalendars === 'function'
          ? ms.getAvailableCalendars()
          : [];
        push(ms.getAllEvents(), (ev) => {
          const calId = String(ev.subscriptionId || '').replace(/^microsoft-/, '');
          const cal = findProviderCalendar(calendars, calId);
          if (!calendarIsEnabled(cal)) return null;
          return {
            calendarName: calendarLabel(cal, 'Microsoft Calendar'),
            color: ev.color || calendarColor(cal, MICROSOFT_DEFAULT_COLOR),
          };
        });
      } catch (e) { /* never break the agenda */ }
    }

    return out;
  }

  // Events for a day key map, optionally dropping ones that already ended today.
  bucketCalendarEvents(events, todayKey, hideFinished) {
    const buckets = new Map();
    const now = moment();
    for (const ev of events) {
      if (hideFinished) {
        const keys = eventDateKeys(ev);
        if (keys.includes(todayKey) && eventHasEnded(ev, now)) {
          // Still show on other days of a multi-day span; drop only the today slot.
          for (const key of keys) {
            if (key === todayKey) continue;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ev);
          }
          continue;
        }
      }
      for (const key of eventDateKeys(ev)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(ev);
      }
    }
    return buckets;
  }

  showEventsEnabled(opts) {
    if (opts && typeof opts.events === 'boolean') return opts.events;
    return !!this.settings.showCalendarEvents;
  }

  openEventMenu(ev, mouseEvent) {
    const menu = new Menu();
    const tn = this.getTaskNotes();
    const noteSvc = tn && tn.icsNoteService;

    menu.addItem((item) => item
      .setTitle('Create task from event')
      .setIcon('check-circle')
      .onClick(async () => {
        if (!noteSvc || typeof noteSvc.createTaskFromICS !== 'function') {
          new Notice('TaskNotes calendar integration is not available.');
          return;
        }
        try {
          await noteSvc.createTaskFromICS(ev);
          new Notice(`Task created: ${ev.title}`);
        } catch (e) {
          new Notice('Could not create task from event.');
        }
      }));

    menu.addItem((item) => item
      .setTitle('Create note from event')
      .setIcon('file-plus')
      .onClick(async () => {
        if (!noteSvc || typeof noteSvc.createNoteFromICS !== 'function') {
          new Notice('TaskNotes calendar integration is not available.');
          return;
        }
        try {
          await noteSvc.createNoteFromICS(ev);
          new Notice(`Note created: ${ev.title}`);
        } catch (e) {
          new Notice('Could not create note from event.');
        }
      }));

    if (ev.url) {
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle('Open link')
        .setIcon('external-link')
        .onClick(() => {
          window.open(ev.url, '_blank', 'noopener');
        }));
    }

    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle('Copy title')
      .setIcon('copy')
      .onClick(async () => {
        try {
          await navigator.clipboard.writeText(ev.title || '');
          new Notice('Title copied');
        } catch (e) {
          new Notice('Could not copy title.');
        }
      }));

    if (mouseEvent) menu.showAtMouseEvent(mouseEvent);
    else menu.showAtPosition({ x: 0, y: 0 });
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
    const tn = this.getTaskNotes();
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
    this.eventsVisible = true; // session toggle; only relevant when feature is on
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

  formatEventTime(ev) {
    if (ev.allDay || !hasClockTime(ev.start)) return 'All day';
    const start = moment(ev.start, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
    if (!start.isValid()) return 'All day';
    const startLabel = start.format('HH:mm');
    if (!ev.end || !hasClockTime(ev.end)) return startLabel;
    const end = moment(ev.end, [moment.ISO_8601, 'YYYY-MM-DDTHH:mm']);
    if (!end.isValid()) return startLabel;
    return `${startLabel} – ${end.format('HH:mm')}`;
  }

  sortMixedItems(items, cfg) {
    const wt = (p) => (cfg.prioMap[p] && cfg.prioMap[p].weight) || 0;
    const untimed = [];
    const timed = [];
    for (const item of items) {
      if (itemSortTime(item) == null) untimed.push(item);
      else timed.push(item);
    }
    untimed.sort((a, b) => {
      if (a.isEvent !== b.isEvent) return a.isEvent ? 1 : -1; // tasks before events among untimed
      if (!a.isEvent && !b.isEvent) {
        return wt(b.priority) - wt(a.priority) || a.title.localeCompare(b.title);
      }
      return (a.title || '').localeCompare(b.title || '');
    });
    timed.sort((a, b) => {
      const ta = itemSortTime(a);
      const tb = itemSortTime(b);
      if (ta !== tb) return ta - tb;
      if (a.isEvent !== b.isEvent) return a.isEvent ? 1 : -1;
      return (a.title || '').localeCompare(b.title || '');
    });
    return untimed.concat(timed);
  }

  render() {
    const cfg = this.plugin.getConfig();
    const active = this.plugin.getTasks(cfg).filter((t) => !t.done);
    const today = moment().startOf('day');
    const todayKey = today.format('YYYY-MM-DD');
    const featureOn = this.plugin.showEventsEnabled(this.opts);
    const showEvents = featureOn && this.eventsVisible;

    let eventBuckets = new Map();
    if (showEvents) {
      const events = this.plugin.getCalendarEvents();
      eventBuckets = this.plugin.bucketCalendarEvents(
        events,
        todayKey,
        !!this.plugin.settings.hideFinishedEventsToday
      );
    }

    const eventsFor = (dayMoment) => eventBuckets.get(dayMoment.format('YYYY-MM-DD')) || [];

    const overdue = active.filter((t) => t.due && moment(t.due, ['YYYY-MM-DD', moment.ISO_8601]).isBefore(today, 'day'));
    const unplanned = active.filter((t) => !t.due && !t.scheduled);
    const todoToday = active.filter((t) => this.sameDay(t.scheduled, today) || this.sameDay(t.due, today));
    const todayEvents = eventsFor(today);

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

    const titleRow = root.createDiv({ cls: 'fw-agenda__title-row' });
    titleRow.createDiv({ cls: 'fw-agenda__title', text: this.opts.title });
    if (featureOn) {
      const btn = titleRow.createDiv({
        cls: 'fw-agenda__events-toggle' + (this.eventsVisible ? ' is-active' : ''),
        attr: {
          'aria-label': this.eventsVisible ? 'Hide calendar events' : 'Show calendar events',
          role: 'button',
        },
      });
      setIcon(btn, 'calendar');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.eventsVisible = !this.eventsVisible;
        this.render();
      });
    }

    // clickable, colored stat tiles that filter the list
    const stats = root.createDiv({ cls: 'fw-agenda__stats' });
    const tile = (num, label, key) => {
      const t = stats.createDiv({ cls: `fw-stat fw-stat--${key}` + (this.filter === key ? ' is-active' : '') });
      t.createDiv({ cls: 'fw-stat__num', text: String(num) });
      t.createDiv({ cls: 'fw-stat__label', text: label });
      t.setAttribute('aria-label', `Show ${label.toLowerCase()}`);
      t.addEventListener('click', () => { this.filter = this.filter === key ? null : key; this.render(); });
    };
    // Todo count matches the Todo filter list (tasks + today's events when visible).
    tile(todoToday.length + todayEvents.length, 'Todo', 'todo');
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
      const todayItems = todoToday.concat(todayEvents);
      todayItems.length
        ? this.renderSection(root, 'Today', todayItems, cfg, false)
        : this.empty(root, 'No tasks for today.');
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
        const tasks = active.filter((t) => this.sameDay(t.scheduled, day) || this.sameDay(t.due, day));
        const dayEvents = eventsFor(day);
        const items = tasks.concat(dayEvents);
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
    const sorted = this.sortMixedItems(items.slice(), cfg);
    for (const item of sorted) {
      if (item.isEvent) this.renderEvent(root, item);
      else this.renderTask(root, item, cfg);
    }
  }

  renderEvent(root, ev) {
    const color = ev.color || '#7aa2f7';
    const row = root.createDiv({ cls: 'fw-task fw-event' });
    row.style.setProperty('--fw-event-color', color);

    const dots = row.createDiv({ cls: 'fw-task__dots fw-event__dots' });
    const bar = dots.createDiv({ cls: 'fw-event__bar' });
    bar.style.background = color;
    const icon = dots.createDiv({ cls: 'fw-event__icon', attr: { 'aria-label': 'Calendar event' } });
    icon.style.color = color;
    setIcon(icon, 'calendar');

    const body = row.createDiv({ cls: 'fw-task__body' });
    const titleEl = body.createDiv({ cls: 'fw-task__title fw-event__title', text: ev.title || 'Untitled event' });
    titleEl.setAttribute('role', 'button');
    titleEl.setAttribute('tabindex', '0');
    titleEl.setAttribute('aria-label', 'Calendar event options');

    const openMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.openEventMenu(ev, e);
    };
    titleEl.addEventListener('click', openMenu);
    titleEl.addEventListener('contextmenu', openMenu);
    titleEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      openMenu(e);
    });
    row.addEventListener('contextmenu', openMenu);

    const meta = body.createDiv({ cls: 'fw-task__meta' });
    const parts = [{ cls: 'fw-event__time', text: this.formatEventTime(ev) }];
    if (ev.calendarName) parts.push({ text: ev.calendarName });
    if (ev.location) parts.push({ text: ev.location });
    parts.forEach((part, i) => {
      if (i) meta.createSpan({ cls: 'fw-sep', text: '·' });
      meta.createSpan(part);
    });
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
      .setName('Show calendar events')
      .setDesc('When TaskNotes has calendar integrations active (ICS subscriptions, Google, or Microsoft), show those events alongside tasks in each day. Click an event for options like creating a task or note from it.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.showCalendarEvents)
        .onChange(async (v) => {
          this.plugin.settings.showCalendarEvents = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Hide events that already ended today')
      .setDesc('When showing calendar events, omit today\'s events whose end time has already passed. Multi-day events still appear on their remaining days.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.hideFinishedEventsToday)
        .onChange(async (v) => {
          this.plugin.settings.hideFinishedEventsToday = v;
          await this.plugin.saveSettings();
        }));

    if (!this.plugin.hasCalendarIntegration()) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'No TaskNotes calendar integration detected. Enable ICS subscriptions, Google Calendar, or Microsoft Calendar in TaskNotes settings to use these options.',
      });
    }
  }
}
