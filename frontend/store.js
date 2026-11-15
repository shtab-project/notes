import { rewriteWikiLinks } from './markdown.js';

export const noteTitle = (note) => note.title.trim() || 'Без названия';
export const notePath = (note) => [note.folder, noteTitle(note)].filter(Boolean).join('/');
export const inFolder = (path, folder) => path === folder || path.startsWith(`${folder}/`);
export const parentFolder = (path) => path.split('/').slice(0, -1).join('/');
const normalize = (value) => value.trim().normalize('NFC').toLocaleLowerCase('ru');

export function resolveNote(notes, target, source) {
  const name = normalize(target.replace(/^\//, ''));
  const qualified = target.includes('/');
  const key = qualified ? notePath : noteTitle;
  const find = (value) => notes.filter((note) => normalize(key(note)) === value);
  let matches = find(name);
  if (!matches.length && name.endsWith('.md')) matches = find(name.slice(0, -3));
  if (!qualified) {
    const nearby = matches.filter((note) => note.folder === source?.folder);
    if (nearby.length === 1) return nearby[0];
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export class NotesStore {
  constructor(userId, scope, onStatus) {
    this.legacyKey = `shtab.notes.v1.${userId}`;
    this.key = `shtab.notes.active.${userId}.${scope}`;
    this.scope = scope;
    this.endpoint = `/api/plugins/notes/workspace/${scope}`;
    this.onStatus = onStatus;
    this.notes = [];
    this.folders = [];
    this.activeId = null;
    this.warning = '';
    this.editable = false;
    this.pending = null;
  }

  async request(url, method = 'GET', payload) {
    const response = await fetch(url, {
      method, credentials: 'same-origin',
      ...(payload && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    if (response.status === 409) throw new Error('Заметки изменились на сервере. Скопируйте свои правки перед обновлением.');
    if (!response.ok) throw new Error('Не удалось синхронизировать заметки. Скопируйте несохранённые правки перед обновлением.');
    return response.json();
  }

  legacy() {
    try {
      const raw = localStorage.getItem(this.legacyKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.notes) || !data.notes.every((note) => note
        && typeof note.id === 'string' && typeof note.title === 'string'
        && typeof note.body === 'string' && typeof note.pinned === 'boolean'
        && Number.isFinite(Date.parse(note.created_at)) && Number.isFinite(Date.parse(note.updated_at)))
        || new Set(data.notes.map((note) => note.id)).size !== data.notes.length) {
        throw new Error('Invalid saved notes');
      }
      return {
        notes: data.notes.map((note) => ({ ...note, folder: typeof note.folder === 'string' ? note.folder : '' })),
        folders: Array.isArray(data.folders) ? data.folders.filter((folder) => typeof folder === 'string') : [],
        activeId: data.activeId,
      };
    } catch {
      this.warning = 'Не удалось прочитать заметки из браузера. Локальная копия сохранена.';
    }
  }

  async load() {
    if (this.hasUnsavedChanges && !await this.save()) return;
    const snapshot = await this.request(this.endpoint);
    const legacy = this.scope === 'private' ? this.legacy() : null;
    if (legacy) {
      try {
        const { activeId, ...data } = legacy;
        if (data.notes.length || data.folders.length) {
          Object.assign(snapshot, await this.request('/api/plugins/notes/import', 'POST', data));
        }
        if (activeId) localStorage.setItem(this.key, activeId);
        localStorage.removeItem(this.legacyKey);
      } catch {
        this.warning = 'Не удалось перенести заметки. Локальная копия сохранена, повторим при открытии раздела.';
      }
    }
    this.editable = snapshot.editable;
    this.canPublish = snapshot.can_publish;
    this.revision = snapshot.revision;
    this.notes = snapshot.notes;
    this.folders = snapshot.folders;
    this.rememberSnapshot();
    let activeId = this.activeId;
    try { activeId ??= localStorage.getItem(this.key); } catch { /* Selection is optional. */ }
    this.activeId = this.notes.some((note) => note.id === activeId) ? activeId : this.notes[0]?.id ?? null;
  }

  rememberSnapshot() {
    this.savedNotes = new Map(this.notes.map((note) => [note.id, JSON.stringify(note)]));
    this.savedFolders = JSON.stringify(this.folders);
  }

  get hasUnsavedChanges() {
    return this.editable && (Boolean(this.pending)
      || this.notes.length !== this.savedNotes.size
      || this.notes.some((note) => this.savedNotes.get(note.id) !== JSON.stringify(note))
      || JSON.stringify(this.folders) !== this.savedFolders);
  }

  save() {
    if (!this.editable) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.sync()).finally(() => { this.pending = null; });
    return this.pending;
  }

  async sync() {
    try {
      while (true) {
        const entries = structuredClone(this.notes);
        const current = new Map(entries.map((note) => [note.id, JSON.stringify(note)]));
        const folders = [...this.folders];
        const folderState = JSON.stringify(folders);
        const upsert = entries.filter((note) => this.savedNotes.get(note.id) !== current.get(note.id));
        const deleted = [...this.savedNotes.keys()].filter((id) => !current.has(id));
        const changedFolders = folderState !== this.savedFolders;
        if (!upsert.length && !deleted.length && !changedFolders) return true;
        const result = await this.request(this.endpoint, 'PATCH', {
          revision: this.revision, upsert, delete: deleted, ...(changedFolders && { folders }),
        });
        this.revision = result.revision;
        for (const [id, metadata] of Object.entries(result.metadata ?? {})) {
          const live = this.notes.find((note) => note.id === id);
          if (live) Object.assign(live, metadata);
          const saved = entries.find((note) => note.id === id);
          current.set(id, JSON.stringify(Object.assign(saved, metadata)));
        }
        this.savedNotes = current;
        this.savedFolders = folderState;
        this.warning = '';
        this.onStatus(Boolean(result.metadata));
      }
    } catch (error) {
      this.warning = error.message;
      this.onStatus();
      return false;
    }
  }

  async publish(id) {
    if (!await this.save()) return false;
    const result = await this.request(`/api/plugins/notes/${encodeURIComponent(id)}/publish`, 'POST', {
      revision: this.revision,
    });
    this.revision = result.revision;
    this.savedNotes.delete(id);
    this.notes = this.notes.filter((note) => note.id !== id);
    if (this.activeId === id) this.select(this.notes[0]?.id ?? null);
    return true;
  }

  get active() {
    return this.notes.find((note) => note.id === this.activeId);
  }

  create(title = '', folder = '', body = '') {
    const now = new Date().toISOString();
    const note = { id: crypto.randomUUID(), title, folder, body, pinned: false, created_at: now, updated_at: now };
    this.notes.unshift(note);
    this.select(note.id);
    this.save();
    return note;
  }

  addFolder(path) {
    if (!this.folders.includes(path)) this.folders.push(path);
    this.save();
  }

  folderPaths() {
    const folders = new Set();
    for (const path of [...this.folders, ...this.notes.map((note) => note.folder)]) {
      const parts = path.split('/').filter(Boolean);
      parts.forEach((_, index) => folders.add(parts.slice(0, index + 1).join('/')));
    }
    return [...folders].sort((left, right) => left.localeCompare(right, 'ru'));
  }

  relocateNote(id, title, folder) {
    const note = this.notes.find((item) => item.id === id);
    if (!note || (note.title === title && note.folder === folder)) return;
    this.applyLocations(new Map([[id, { title, folder }]]), this.folderPaths());
  }

  relocateFolder(source, destination) {
    if (source === destination) return;
    const folders = this.folderPaths();
    if (!folders.includes(source) || inFolder(destination, source)
      || folders.some((folder) => normalize(folder) === normalize(destination) && folder !== source)) {
      throw new Error('В этой папке уже есть папка с таким именем или выбран недопустимый путь.');
    }
    const remap = (path) => inFolder(path, source) ? destination + path.slice(source.length) : path;
    const locations = new Map(this.notes.filter((note) => inFolder(note.folder, source))
      .map((note) => [note.id, { folder: remap(note.folder) }]));
    this.applyLocations(locations, folders.map(remap));
  }

  applyLocations(locations, folders) {
    const previous = this.notes;
    const now = new Date().toISOString();
    const next = previous.map((note) => ({ ...note, ...locations.get(note.id) }));
    const byId = new Map(next.map((note) => [note.id, note]));
    next.forEach((note, index) => {
      const original = previous[index];
      note.body = rewriteWikiLinks(original.body, (target) => {
        const linked = resolveNote(previous, target, original);
        if (!linked || resolveNote(next, target, note)?.id === linked.id) return target;
        const path = notePath(byId.get(linked.id));
        if (/[\[\]|\n]/.test(path) || resolveNote(next, `/${path}`)?.id !== linked.id) return target;
        return `/${path}`;
      });
      if (locations.has(note.id) || note.body !== original.body) note.updated_at = now;
    });
    this.notes = next;
    this.folders = folders;
    this.save();
  }

  removeFolder(path) {
    this.folders = this.folderPaths().filter((folder) => !inFolder(folder, path));
    this.notes = this.notes.filter((note) => !inFolder(note.folder, path));
    if (!this.active) this.select(this.notes[0]?.id ?? null);
    this.save();
  }

  update(values) {
    const note = this.active;
    if (!note) return;
    Object.assign(note, values, { updated_at: new Date().toISOString() });
    this.save();
  }

  remove(id) {
    this.notes = this.notes.filter((note) => note.id !== id);
    if (this.activeId === id) this.select(this.notes[0]?.id ?? null);
    this.save();
  }

  select(id) {
    this.activeId = id;
    try {
      if (id) localStorage.setItem(this.key, id);
      else localStorage.removeItem(this.key);
    } catch { /* Selection is optional. */ }
  }
}
