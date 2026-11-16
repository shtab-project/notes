import { NotesStore, noteTitle as title, notePath, resolveNote, inFolder, parentFolder } from './store.js';
import { escape, markdown, tags, wikiLinks } from './markdown.js';

const explorerItem = '.note-item[data-id], .folder-name[data-folder]';
const noteDate = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });

const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h5"/>',
  pin: '<path d="m8 3 8 0-1 6 4 4v2H5v-2l4-4ZM12 15v7"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  links: '<path d="M10 13a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2m3 5a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;

class NotesElement extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const controller = new AbortController();
    this.controller = controller;
    this.query = '';
    this.pinned = false;
    this.mode = 'edit';
    this.mobileEditor = false;
    this.closedFolders = new Set();
    this.tag = '';
    this.showLinks = false;
    this.switching = false;
    this.publishing = false;
    this.shadowRoot.replaceChildren();
    this.hidden = true;
    this.start(controller);
  }

  disconnectedCallback() { this.controller.abort(); }

  async start(controller) {
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Не удалось загрузить профиль. Обновите страницу.');
      const { user } = await response.json();
      if (controller.signal.aborted) return;
      const createStore = (scope) => new NotesStore(user.id, scope, (metadataChanged) => {
        if (controller.signal.aborted || this.store.scope !== scope) return;
        this.renderStatus();
        if (metadataChanged) {
          this.renderList();
          this.renderMetadata();
        }
      });
      this.stores = { private: createStore('private'), shared: createStore('shared') };
      this.store = this.stores.private;
      await this.store.load();
      if (controller.signal.aborted) return;
      this.shell(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.showError(error.message);
    }
  }

  showError(message) {
    this.shadowRoot.innerHTML = `<p role="alert">${escape(message)}</p>`;
    this.hidden = false;
  }

  shell(signal) {
    this.shadowRoot.innerHTML = `
      <div class="notes-layout">
        <div class="editor-top" hidden></div>
        <aside class="notes-sidebar" aria-label="Ваши заметки">
          <div class="list-filters scope-filters" role="group" aria-label="Доступ к заметкам"><button data-scope="private">Личные</button><button data-scope="shared">Общие</button></div>
          <div class="explorer-bar">
            <button class="button primary explorer-create" data-action="create">${icon('plus')}Новая заметка</button>
            <button class="icon-button" data-action="folder" title="Новая папка" aria-label="Новая папка">${icon('folder')}</button>
            <button class="icon-button" data-action="import" title="Импорт Markdown" aria-label="Импорт Markdown">⇧</button>
          </div>
          <label class="search">${icon('search')}<input type="search" aria-label="Найти заметку" placeholder="Найти заметку"></label>
          <div class="explorer-heading"><h2>Все заметки</h2><button class="text-button" data-action="folder">${icon('plus')}Папка</button></div>
          <input class="import-file" type="file" accept=".md,.markdown,text/markdown" multiple hidden>
          <div class="note-list" aria-label="Список заметок"></div>
          <div class="tag-list" aria-label="Теги"></div>
        </aside>
        <section class="editor-area" aria-label="Заметка"></section>
      </div>
      <p class="storage-warning" role="alert" hidden></p>
      <div class="note-menu" role="menu" aria-label="Действия" hidden></div>
      <dialog class="delete-dialog" aria-labelledby="delete-heading"><h2 id="delete-heading">Удалить заметку?</h2><p class="delete-message"></p><p class="delete-hint">Восстановить её не получится.</p><div><button class="button" data-action="cancel-delete">Оставить</button><button class="button danger" data-action="confirm-delete">Удалить заметку</button></div></dialog>
      <dialog class="folder-dialog" aria-labelledby="folder-heading"><form><h2 id="folder-heading">Новая папка</h2><label>Путь папки<input required maxlength="160" name="folder" placeholder="Например, Проекты / Shtab"></label><footer><button type="button" class="button" data-action="cancel-folder">Отмена</button><button class="button primary">Создать папку</button></footer></form></dialog>
      <dialog class="move-dialog" aria-labelledby="move-heading"><form><h2 id="move-heading">Переместить</h2><label>Папка назначения<select required name="target" autofocus></select></label><p class="move-error" role="alert" hidden></p><footer><button type="button" class="button" data-action="cancel-move">Отмена</button><button class="button primary">Переместить</button></footer></form></dialog>
      <dialog class="publish-dialog" aria-labelledby="publish-heading"><h2 id="publish-heading">Опубликовать в общие?</h2><p class="publish-name"></p><p>Заметка переместится в общие и станет видна всем пользователям Shtab.</p><p class="publish-error" role="alert" hidden></p><div><button class="button" data-action="cancel-publish" autofocus>Отмена</button><button class="button primary" data-action="confirm-publish">Опубликовать</button></div></dialog>`;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./style.css', import.meta.url).href;
    stylesheet.addEventListener('load', () => { this.hidden = false; }, { once: true, signal });
    stylesheet.addEventListener('error', () => this.showError('Не удалось загрузить оформление заметок. Обновите страницу.'), { once: true, signal });
    this.shadowRoot.prepend(stylesheet);
    const options = { signal };
    this.shadowRoot.addEventListener('click', (event) => this.click(event), options);
    this.shadowRoot.addEventListener('input', (event) => this.input(event), options);
    this.shadowRoot.addEventListener('change', (event) => this.change(event), options);
    this.shadowRoot.addEventListener('contextmenu', (event) => {
      const row = event.target.closest(explorerItem);
      if (!row) return;
      event.preventDefault();
      const bounds = row.getBoundingClientRect();
      const pointer = event.clientX || event.clientY;
      this.openNoteMenu(row, pointer ? event.clientX : bounds.left, pointer ? event.clientY : bounds.bottom);
    }, options);
    document.addEventListener('pointerdown', (event) => {
      if (!event.composedPath().includes(this.shadowRoot.querySelector('.note-menu'))) this.closeNoteMenu();
    }, options);
    window.addEventListener('resize', () => this.closeNoteMenu(true), options);
    const sidebar = this.shadowRoot.querySelector('.notes-sidebar');
    sidebar.addEventListener('scroll', () => this.closeNoteMenu(true), options);
    sidebar.addEventListener('dragstart', (event) => this.startDrag(event), options);
    sidebar.addEventListener('dragover', (event) => this.dragOver(event), options);
    sidebar.addEventListener('drop', (event) => this.drop(event), options);
    sidebar.addEventListener('dragend', () => this.clearDrag(), options);
    sidebar.addEventListener('dragleave', (event) => {
      if (!sidebar.contains(event.relatedTarget)) this.setDropTarget(null);
    }, options);
    this.shadowRoot.querySelector('.folder-dialog form').addEventListener('submit', (event) => this.createFolder(event), options);
    this.shadowRoot.querySelector('.move-dialog form').addEventListener('submit', (event) => this.submitMove(event), options);
    this.shadowRoot.querySelector('.publish-dialog').addEventListener('cancel', (event) => {
      if (this.publishing) event.preventDefault();
    }, options);
    window.addEventListener('beforeunload', (event) => {
      if (!Object.values(this.stores).some((store) => store.hasUnsavedChanges)) return;
      event.preventDefault();
      event.returnValue = true;
    }, options);
    this.shadowRoot.addEventListener('keydown', (event) => {
      const row = event.target.closest(explorerItem);
      if (row && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        const bounds = row.getBoundingClientRect();
        this.openNoteMenu(row, bounds.left, bounds.bottom);
        return;
      }
      if (row && this.store.editable && event.key === 'Delete') {
        event.preventDefault();
        this.confirmDeletion(this.entry(row));
        return;
      }
      if (event.target.closest('.note-menu') && ['Escape', 'Tab'].includes(event.key)) {
        event.preventDefault();
        this.closeNoteMenu(true);
        return;
      }
      const menu = event.target.closest('.note-menu');
      if (menu && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = [...menu.querySelectorAll('button')];
        const index = items.indexOf(event.target);
        const offset = event.key === 'ArrowUp' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + offset + items.length) % items.length;
        items[next].focus();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
        event.preventDefault();
        this.store.save();
        this.renderStatus();
      }
      if (event.target.matches('.note-body') && (event.ctrlKey || event.metaKey) && ['KeyB', 'KeyI'].includes(event.code)) {
        event.preventDefault();
        this.format(event.code === 'KeyB' ? 'bold' : 'italic');
      }
      if (event.target.matches('.note-title') && event.key === 'Enter') {
        event.preventDefault();
        this.shadowRoot.querySelector('.note-body')?.focus();
      }
      if (event.target.matches('.note-body') && event.key === 'Escape') {
        this.shadowRoot.querySelector('.link-suggestions').hidden = true;
      }
      if (event.target.matches('.note-body') && event.key === 'ArrowDown') {
        const suggestion = this.shadowRoot.querySelector('.link-suggestions:not([hidden]) button');
        if (suggestion) { event.preventDefault(); suggestion.focus(); }
      }
    }, options);
    this.render();
  }

  filtered() {
    const query = this.query.trim().toLocaleLowerCase('ru');
    return this.store.notes.filter((note) => (!this.pinned || note.pinned)
      && (!this.tag || tags(note.body).includes(this.tag))
      && (!query || `${notePath(note)}\n${note.body}`.toLocaleLowerCase('ru').includes(query)))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }

  render() {
    this.renderList();
    this.renderEditor();
    this.renderStatus();
  }

  renderList() {
    this.closeNoteMenu();
    const root = this.shadowRoot;
    root.querySelectorAll('[data-scope]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.scope === this.store.scope)));
    root.querySelector('.explorer-bar').hidden = !this.store.editable;
    root.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed',
      String((button.dataset.filter === 'pinned') === this.pinned)));
    const notes = this.filtered();
    root.querySelector('.explorer-heading button').hidden = !this.store.editable;
    const filtered = Boolean(this.query || this.tag);
    const pinned = notes.filter((note) => note.pinned);
    const regular = notes.filter((note) => !note.pinned);
    const pinnedItems = pinned.length ? `<div class="explorer-label">${icon('pin')}Закреплённые</div>${pinned.map((note) => this.noteItem(note, true)).join('')}` : '';
    const items = pinnedItems + (filtered ? regular.map((note) => this.noteItem(note, true)).join('') : this.tree(regular));
    const list = root.querySelector('.note-list');
    const scroll = list.scrollTop;
    list.innerHTML = (items || `<p class="list-empty">${filtered ? 'Ничего не найдено' : 'Пока нет заметок'}</p>`)
      + '<div class="root-drop" data-drop-folder="" hidden>Переместить в корень</div>';
    list.scrollTop = scroll;
    const allTags = [...new Set(this.store.notes.flatMap((note) => tags(note.body)))].sort();
    root.querySelector('.tag-list').innerHTML = allTags.map((tag) =>
      `<button class="tag-link" data-tag="${escape(tag)}" aria-pressed="${this.tag === tag}">#${escape(tag)}</button>`).join('');
  }

  noteItem(note, showPath = false) {
    const active = note.id === this.store.activeId;
    return `<button class="note-item${active ? ' selected' : ''}" draggable="${this.store.editable}" ${this.store.editable ? 'aria-haspopup="menu"' : ''} data-action="select" data-id="${escape(note.id)}" ${active ? 'aria-current="true"' : ''}>
      <span class="item-title">${icon(note.pinned ? 'pin' : 'note')}${escape(title(note))}</span>${this.noteMetadata(note, true)}${showPath && note.folder ? `<span class="item-preview">${escape(note.folder)}</span>` : ''}</button>`;
  }

  noteMetadata(note, compact = false) {
    if (this.store.scope !== 'shared' || !note?.author_name) return '';
    const timestamp = note.published_at ?? note.created_at;
    const date = new Date(timestamp);
    const label = note.published_at ? 'Опубликовано' : 'Создано';
    return `<span class="note-byline${compact ? ' compact' : ''}">
      <span>${compact ? '' : 'Автор: '}${escape(note.author_name)}</span>
      <span>${label} <time datetime="${escape(timestamp)}">${noteDate.format(date)}</time></span>
    </span>`;
  }

  renderMetadata() {
    const node = this.shadowRoot.querySelector('.note-metadata');
    if (node) node.innerHTML = this.noteMetadata(this.store.active);
  }

  tree(notes) {
    const root = { folders: new Map(), notes: [] };
    const find = (path) => {
      let node = root;
      for (const name of path.split('/').filter(Boolean)) {
        if (!node.folders.has(name)) node.folders.set(name, { folders: new Map(), notes: [] });
        node = node.folders.get(name);
      }
      return node;
    };
    this.store.folders.forEach(find);
    notes.forEach((note) => find(note.folder).notes.push(note));
    const draw = (node, parent = '') => [...node.folders].sort(([left], [right]) => left.localeCompare(right, 'ru')).map(([name, child]) => {
      const path = [parent, name].filter(Boolean).join('/');
      const open = !this.closedFolders.has(path);
      return `<div class="folder-node"><div class="folder-row" data-drop-folder="${escape(path)}"><button class="folder-name" draggable="${this.store.editable}" data-action="toggle-folder" data-folder="${escape(path)}" aria-expanded="${open}"><span class="chevron">›</span>${icon('folder')}<span>${escape(name)}</span></button>${this.store.editable ? `<button class="icon-button folder-add" data-action="create" data-folder="${escape(path)}" aria-label="Новая заметка в папке ${escape(path)}">${icon('plus')}</button><button class="icon-button folder-menu" data-action="folder-menu" aria-label="Действия папки ${escape(path)}" aria-haspopup="menu">⋯</button>` : ''}</div>${open ? `<div class="folder-children">${draw(child, path)}</div>` : ''}</div>`;
    }).join('') + node.notes.map((note) => this.noteItem(note)).join('');
    return draw(root);
  }

  renderEditor() {
    const root = this.shadowRoot;
    root.querySelector('.notes-layout').classList.toggle('editing', this.mobileEditor);
    const note = this.store.active;
    const toolbar = root.querySelector('.editor-top');
    toolbar.hidden = !note;
    if (!note) {
      toolbar.replaceChildren();
      root.querySelector('.editor-area').innerHTML = `<div class="editor-empty">${icon('note')}<h2>Выберите заметку</h2>${this.store.editable ? `<button class="button primary" data-action="create">${icon('plus')}Создать заметку</button>` : ''}</div>`;
      return;
    }
    toolbar.innerHTML = `
      <div class="editor-modes"><button class="icon-button back-list" data-action="back" aria-label="К списку заметок">${icon('back')}</button>
        <div class="mode-switch" data-mode="${this.mode}" role="group" aria-label="Режим заметки"><button data-mode="edit" ${this.store.editable ? '' : 'hidden'} aria-pressed="${this.mode === 'edit'}">Редактор</button><button data-mode="preview" aria-pressed="${this.mode === 'preview'}">Просмотр</button></div>
      </div>
      <div class="editor-actions" role="group" aria-label="Действия с открытой заметкой">
        <button class="icon-button editor-action" data-action="connections" aria-label="Связи заметки" title="Связи заметки" aria-expanded="${this.showLinks}">${icon('links')}<span>Связи</span></button>
        ${this.store.editable ? `<button class="icon-button editor-action pin-button ${note.pinned ? 'active' : ''}" data-action="pin" aria-label="${note.pinned ? 'Открепить заметку' : 'Закрепить заметку'}" title="${note.pinned ? 'Открепить' : 'Закрепить'}">${icon('pin')}<span>${note.pinned ? 'Открепить' : 'Закрепить'}</span></button>
        <button class="icon-button delete-button" data-action="delete" aria-label="Удалить заметку" title="Удалить">${icon('trash')}</button>` : ''}
      </div>`;
    root.querySelector('.editor-area').innerHTML = `
      <div class="editor-grid" ${this.showLinks ? 'data-connections' : ''}>
      <div class="note-content"><input class="note-title" aria-label="Название заметки" placeholder="Без названия" maxlength="200" ${this.store.editable ? '' : 'readonly'} value="${escape(note.title)}" autocomplete="off">
        ${this.store.scope === 'shared' ? '<div class="note-metadata"></div>' : ''}
        <div class="editor-tools" aria-label="Форматирование" ${this.mode === 'preview' ? 'hidden' : ''}><button data-format="bold" title="Жирный текст (Ctrl+B)" aria-label="Жирный текст"><b>B</b></button><button data-format="italic" title="Курсив (Ctrl+I)" aria-label="Курсив"><i>I</i></button><span></span><button data-format="heading" title="Заголовок" aria-label="Заголовок">H</button><button data-format="checklist" title="Список дел" aria-label="Список дел">☑</button><button data-format="wiki" title="Ссылка на заметку" aria-label="Ссылка на заметку">[[ ]]</button><button data-format="link" title="Внешняя ссылка" aria-label="Вставить ссылку">↗</button><button data-format="code" title="Код" aria-label="Код">&lt;/&gt;</button></div>
        <div class="writing-area"><textarea class="note-body" aria-label="Текст заметки" placeholder="Начните писать. Введите [[, чтобы сослаться на заметку." ${this.mode === 'preview' ? 'hidden' : ''}></textarea><div class="link-suggestions" aria-label="Внутренние ссылки" hidden></div></div>
        <article class="markdown" aria-label="Просмотр заметки" ${this.mode === 'edit' ? 'hidden' : ''}></article></div>
        <aside class="connection-panel" aria-label="Связи заметки" ${this.showLinks ? '' : 'hidden'}></aside></div>`;
    root.querySelector('.note-body').value = note.body;
    this.renderMetadata();
    this.renderPreview();
    this.renderConnections();
    this.renderStatus();
  }

  renderPreview() {
    if (this.mode !== 'preview') return;
    const note = this.store.active;
    if (!note) return;
    this.shadowRoot.querySelector('.markdown').innerHTML = markdown(note.body,
      (target) => resolveNote(this.store.notes, target, note)) || '<p class="preview-empty">В заметке пока нет текста.</p>';
    if (!this.store.editable) {
      this.shadowRoot.querySelectorAll('[data-check-line]').forEach((checkbox) => { checkbox.disabled = true; });
    }
  }

  renderConnections() {
    if (!this.showLinks || !this.store.active) return;
    const active = this.store.active;
    const incoming = this.store.notes.filter((note) => note.id !== active.id && wikiLinks(note.body)
      .some((target) => resolveNote(this.store.notes, target, note)?.id === active.id));
    const outgoing = [...new Set(wikiLinks(active.body))];
    this.shadowRoot.querySelector('.connection-panel').innerHTML = `
      <h2>Обратные ссылки <span>${incoming.length}</span></h2>
      <div>${incoming.map((note) => this.noteItem(note, true)).join('') || '<p>Ссылок на эту заметку пока нет.</p>'}</div>
      <h2>Исходящие ссылки <span>${outgoing.length}</span></h2>
      <div>${outgoing.map((target) => `<button class="wiki-link" data-wiki="${escape(target)}">${escape(target)}</button>`).join('') || '<p>Добавьте ссылку через [[название]].</p>'}</div>
      ${this.store.editable ? `<label class="move-field">Папка<select aria-label="Переместить в папку"><option value="">Корень</option>${this.store.folderPaths().map((folder) => `<option value="${escape(folder)}" ${active.folder === folder ? 'selected' : ''}>${escape(folder)}</option>`).join('')}</select></label>` : ''}
      <button class="text-button" data-action="export">Скачать Markdown</button>`;
  }

  renderSuggestions() {
    const textarea = this.shadowRoot.querySelector('.note-body');
    const suggestions = this.shadowRoot.querySelector('.link-suggestions');
    const match = textarea.value.slice(0, textarea.selectionStart).match(/\[\[([^\[\]\n|]*)$/);
    const query = match?.[1].toLocaleLowerCase('ru');
    const choices = match ? this.store.notes.filter((note) => note.title.trim() && !/[\[\]|\n]/.test(notePath(note))
      && notePath(note).toLocaleLowerCase('ru').includes(query)).slice(0, 7) : [];
    suggestions.hidden = !choices.length;
    suggestions.innerHTML = choices.map((note) => `<button type="button" data-insert="${escape(notePath(note))}">${icon('note')}${escape(notePath(note))}</button>`).join('');
  }

  renderStatus() {
    const root = this.shadowRoot;
    const warning = root.querySelector('.storage-warning');
    warning.textContent = this.store.warning;
    warning.hidden = !this.store.warning;
  }

  input(event) {
    if (event.target.matches('input[type="search"]')) {
      this.query = event.target.value;
      this.renderList();
    } else if (event.target.matches('.note-body')) {
      this.store.update({ body: event.target.value });
      this.renderList();
      this.renderStatus();
      this.renderConnections();
      this.renderSuggestions();
    }
  }

  createFolder(event) {
    event.preventDefault();
    const input = event.target.elements.folder;
    const segments = input.value.split('/').map((part) => part.trim()).filter(Boolean);
    if (!segments.length || (this.renameFolder && segments.length !== 1)
      || segments.some((part) => /[\\\[\]|]/.test(part) || part === '.' || part === '..')) {
      input.setCustomValidity('Укажите имя папки. Вложенные папки разделяйте символом /.');
      input.reportValidity();
      input.setCustomValidity('');
      return;
    }
    const path = [this.folderParent, ...segments].filter(Boolean).join('/');
    try {
      if (this.renameFolder) this.store.relocateFolder(this.renameFolder, path);
      else this.store.addFolder(path);
    } catch (error) {
      input.setCustomValidity(error.message);
      input.reportValidity();
      input.setCustomValidity('');
      return;
    }
    this.revealFolder(parentFolder(path));
    event.target.closest('dialog').close();
    this.render();
  }

  async change(event) {
    if (!this.store.editable) return;
    const target = event.target;
    if (target.matches('.note-title')) {
      this.store.relocateNote(this.store.activeId, target.value, this.store.active.folder);
      const body = this.shadowRoot.querySelector('.note-body');
      if (body.value !== this.store.active.body) body.value = this.store.active.body;
      this.renderList();
      this.renderPreview();
      this.renderStatus();
    }
    if (target.matches('.move-field select')) {
      this.moveEntry({ id: this.store.activeId }, target.value);
    }
    if (target.matches('[data-check-line]')) {
      const body = this.store.active.body.replace(/\r\n/g, '\n').split('\n');
      const index = Number(target.dataset.checkLine);
      body[index] = body[index].replace(/^(\s*(?:[-*]|\d+\.)\s+\[)[ xX](\])/, `$1${target.checked ? 'x' : ' '}$2`);
      this.store.update({ body: body.join('\n') });
      this.shadowRoot.querySelector('.note-body').value = this.store.active.body;
      this.renderList();
      this.renderStatus();
    }
    if (target.matches('.import-file')) {
      const files = [...target.files];
      const signal = this.controller.signal;
      try {
        const notes = await Promise.all(files.map(async (file) => ({
          title: file.name.replace(/\.(md|markdown)$/i, '').slice(0, 200), body: await file.text(),
        })));
        if (signal.aborted) return;
        notes.forEach((note) => this.store.create(note.title, '', note.body));
        if (notes.length) this.openNote(this.store.activeId);
      } catch {
        if (!signal.aborted) {
          const warning = this.shadowRoot.querySelector('.storage-warning');
          warning.textContent = 'Не удалось прочитать Markdown-файлы.';
          warning.hidden = false;
        }
      }
      target.value = '';
    }
  }

  openNote(id) {
    this.store.select(id);
    this.mobileEditor = true;
    this.render();
  }

  entry(row) {
    return row.dataset.id ? { id: row.dataset.id } : { folder: row.dataset.folder };
  }

  revealFolder(path) {
    for (let folder = path; folder; folder = parentFolder(folder)) this.closedFolders.delete(folder);
  }

  moveEntry(entry, folder) {
    if (entry.id) {
      const note = this.store.notes.find((item) => item.id === entry.id);
      if (note) this.store.relocateNote(entry.id, note.title, folder);
    } else {
      const name = entry.folder.split('/').at(-1);
      this.store.relocateFolder(entry.folder, [folder, name].filter(Boolean).join('/'));
    }
    this.revealFolder(folder);
    this.render();
  }

  openMove(entry) {
    this.moveSource = entry;
    const dialog = this.shadowRoot.querySelector('.move-dialog');
    const select = dialog.querySelector('select');
    const current = entry.id ? this.store.notes.find((note) => note.id === entry.id)?.folder : parentFolder(entry.folder);
    const options = ['', ...this.store.folderPaths()].filter((folder) => entry.id || !inFolder(folder, entry.folder));
    select.replaceChildren(...options.map((folder) => new Option(folder || 'Корень', `/${folder}`, false, folder === current)));
    dialog.querySelector('.move-error').hidden = true;
    dialog.showModal();
  }

  submitMove(event) {
    event.preventDefault();
    const dialog = event.target.closest('dialog');
    try {
      this.moveEntry(this.moveSource, event.target.elements.target.value.slice(1));
      dialog.close();
    } catch (error) {
      const message = dialog.querySelector('.move-error');
      message.textContent = error.message;
      message.hidden = false;
    }
  }

  startDrag(event) {
    if (!this.store.editable) return;
    const row = event.target.closest(explorerItem);
    if (!row || !event.dataTransfer) return;
    this.dragSource = this.entry(row);
    this.closeNoteMenu();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-shtab-notes', 'move');
    this.shadowRoot.querySelector('.root-drop').hidden = false;
  }

  setDropTarget(target) {
    this.dropTarget?.classList.remove('drop-active');
    this.dropTarget = target;
    target?.classList.add('drop-active');
  }

  dragOver(event) {
    if (!this.dragSource) return;
    const target = event.target.closest('[data-drop-folder]');
    const folder = target?.dataset.dropFolder;
    if (!target || (this.dragSource.folder && inFolder(folder, this.dragSource.folder))) {
      this.setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    this.setDropTarget(target);
  }

  drop(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (!this.dragSource || !target || target !== this.dropTarget) return;
    event.preventDefault();
    const source = this.dragSource;
    this.clearDrag();
    try {
      this.moveEntry(source, target.dataset.dropFolder);
    } catch (error) {
      const warning = this.shadowRoot.querySelector('.storage-warning');
      warning.textContent = error.message;
      warning.hidden = false;
    }
  }

  clearDrag() {
    this.dragSource = null;
    this.setDropTarget(null);
    this.shadowRoot.querySelector('.root-drop').hidden = true;
  }

  click(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.scope) { this.switchScope(button.dataset.scope); return; }
    if (button.dataset.tag) {
      this.tag = this.tag === button.dataset.tag ? '' : button.dataset.tag;
      this.mobileEditor = false;
      this.render();
      return;
    }
    if (button.dataset.wiki) { this.openLink(button.dataset.wiki); return; }
    if (button.dataset.insert) { this.insertLink(button.dataset.insert); return; }
    if (button.dataset.format) { this.format(button.dataset.format); return; }
    if (button.dataset.mode) {
      this.mode = button.dataset.mode;
      this.renderEditor();
      this.shadowRoot.querySelector(`[data-mode="${this.mode}"] button[aria-pressed="true"]`)?.focus();
      return;
    }
    if (button.dataset.filter) {
      this.tag = '';
      this.pinned = button.dataset.filter === 'pinned';
      this.renderList();
      return;
    }
    const action = button.dataset.action;
    if (action?.startsWith('menu-')) {
      const entry = this.entry(this.menuRow);
      this.closeNoteMenu(true);
      if (action === 'menu-publish') this.confirmPublication(entry.id);
      if (action === 'menu-delete') this.confirmDeletion(entry);
      if (action === 'menu-move') this.openMove(entry);
      if (action === 'menu-create-note') this.createNote(entry.folder);
      if (action === 'menu-create-folder') this.openFolderDialog(entry.folder);
      if (action === 'menu-rename') this.openFolderDialog(parentFolder(entry.folder), entry.folder);
      return;
    }
    if (action === 'cancel-publish') this.shadowRoot.querySelector('.publish-dialog').close();
    if (action === 'confirm-publish') this.publishNote(button);
    if (action === 'folder-menu') {
      const bounds = button.getBoundingClientRect();
      this.openNoteMenu(button.closest('.folder-row').querySelector('.folder-name'), bounds.left, bounds.bottom);
    }
    if (action === 'folder') this.openFolderDialog('');
    if (action === 'cancel-folder') this.shadowRoot.querySelector('.folder-dialog').close();
    if (action === 'cancel-move') this.shadowRoot.querySelector('.move-dialog').close();
    if (action === 'toggle-folder') {
      const path = button.dataset.folder;
      if (this.closedFolders.has(path)) this.closedFolders.delete(path);
      else this.closedFolders.add(path);
      this.renderList();
      this.shadowRoot.querySelector(`[data-action="toggle-folder"][data-folder="${CSS.escape(path)}"]`)?.focus();
    }
    if (action === 'connections') {
      this.showLinks = !this.showLinks;
      this.renderEditor();
      this.shadowRoot.querySelector('[data-action="connections"]').focus();
    }
    if (action === 'import') this.shadowRoot.querySelector('.import-file').click();
    if (action === 'export') this.exportNote();
    if (action === 'create') this.createNote(button.dataset.folder || '');
    if (action === 'select') {
      this.openNote(button.dataset.id);
    }
    if (action === 'back') {
      this.mobileEditor = false;
      this.shadowRoot.querySelector('.notes-layout').classList.remove('editing');
    }
    if (action === 'reset') {
      this.query = ''; this.tag = ''; this.pinned = false;
      this.shadowRoot.querySelector('input[type="search"]').value = '';
      this.renderList();
    }
    if (action === 'pin') {
      this.store.update({ pinned: !this.store.active.pinned });
      this.render();
      this.shadowRoot.querySelector('.pin-button').focus();
    }
    if (action === 'delete') this.confirmDeletion({ id: this.store.activeId });
    if (action === 'cancel-delete') this.shadowRoot.querySelector('.delete-dialog').close();
    if (action === 'confirm-delete') {
      if (this.deleteEntry.id) this.store.remove(this.deleteEntry.id);
      else this.store.removeFolder(this.deleteEntry.folder);
      this.shadowRoot.querySelector('.delete-dialog').close();
      if (!this.store.active) this.mobileEditor = false;
      this.render();
      const focusTarget = this.shadowRoot.querySelector('.note-list [aria-current="true"]')
        ?? this.shadowRoot.querySelector('.note-list .note-item')
        ?? this.shadowRoot.querySelector('.explorer-create');
      if (focusTarget.getClientRects().length) focusTarget.focus({ preventScroll: true });
    }
  }

  async switchScope(scope) {
    if (this.switching || this.store.scope === scope) return;
    this.switching = true;
    const { signal } = this.controller;
    const next = this.stores[scope];
    const sidebar = this.shadowRoot.querySelector('.scope-filters');
    sidebar.setAttribute('aria-busy', 'true');
    try {
      await next.load();
      if (signal.aborted) return;
      this.store = next;
      this.query = ''; this.tag = ''; this.pinned = false;
      this.mode = next.editable ? 'edit' : 'preview';
      this.showLinks = false; this.mobileEditor = false;
      this.closedFolders.clear();
      this.shadowRoot.querySelector('.search input').value = '';
      this.render();
    } catch (error) {
      if (!signal.aborted) {
        this.store.warning = error.message;
        this.renderStatus();
      }
    } finally {
      this.switching = false;
      sidebar.removeAttribute('aria-busy');
    }
  }

  confirmPublication(id) {
    const note = this.store.notes.find((entry) => entry.id === id);
    const dialog = this.shadowRoot.querySelector('.publish-dialog');
    this.publishId = id;
    dialog.querySelector('.publish-name').textContent = title(note);
    dialog.querySelector('.publish-error').hidden = true;
    dialog.showModal();
  }

  async publishNote(button) {
    if (this.publishing) return;
    const store = this.store;
    const dialog = button.closest('dialog');
    this.publishing = true;
    dialog.querySelectorAll('button').forEach((control) => { control.disabled = true; });
    try {
      if (!await store.publish(this.publishId)) throw new Error(store.warning);
      dialog.close();
      this.render();
      await this.switchScope('shared');
    } catch (error) {
      const message = dialog.querySelector('.publish-error');
      message.textContent = error.message;
      message.hidden = false;
    } finally {
      this.publishing = false;
      dialog.querySelectorAll('button').forEach((control) => { control.disabled = false; });
    }
  }

  createNote(folder) {
    this.store.create('', folder);
    this.revealFolder(folder);
    this.query = ''; this.tag = ''; this.pinned = false; this.mode = 'edit'; this.mobileEditor = true;
    this.shadowRoot.querySelector('input[type="search"]').value = '';
    this.render();
    this.shadowRoot.querySelector('.note-title').focus();
  }

  openFolderDialog(parent, rename = '') {
    this.folderParent = parent;
    this.renameFolder = rename;
    const dialog = this.shadowRoot.querySelector('.folder-dialog');
    const form = dialog.querySelector('form');
    form.reset();
    form.elements.folder.value = rename.split('/').at(-1);
    dialog.querySelector('h2').textContent = rename ? 'Переименовать папку' : 'Новая папка';
    form.querySelector('.primary').textContent = rename ? 'Переименовать' : 'Создать папку';
    dialog.showModal();
    form.elements.folder.select();
  }

  openNoteMenu(row, x, y) {
    if (!this.store.editable) return;
    const menu = this.shadowRoot.querySelector('.note-menu');
    this.menuRow = row;
    const folder = !row.dataset.id;
    menu.setAttribute('aria-label', folder ? 'Действия с папкой' : 'Действия с заметкой');
    const actions = folder ? [
      ['create-note', 'plus', 'Новая заметка'],
      ['create-folder', 'folder', 'Новая папка'],
      ['rename', 'folder', 'Переименовать'],
      ['move', 'folder', 'Переместить…'],
      ['delete', 'trash', 'Удалить папку'],
    ] : [
      ['move', 'folder', 'Переместить…'],
      ['delete', 'trash', 'Удалить заметку'],
    ];
    if (!folder && this.store.scope === 'private' && this.store.canPublish) {
      actions.unshift(['publish', 'links', 'Опубликовать в общие…']);
    }
    menu.innerHTML = actions.map(([action, symbol, label]) =>
      `<button type="button" role="menuitem" tabindex="-1" data-action="menu-${action}">${icon(symbol)}${label}</button>`).join('');
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button').focus({ preventScroll: true });
  }

  closeNoteMenu(restoreFocus = false) {
    const menu = this.shadowRoot.querySelector('.note-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (restoreFocus) this.menuRow?.focus({ preventScroll: true });
    this.menuRow = null;
  }

  confirmDeletion(entry) {
    const note = this.store.notes.find((item) => item.id === entry.id);
    if (!note && !entry.folder) return;
    this.deleteEntry = entry;
    const dialog = this.shadowRoot.querySelector('.delete-dialog');
    dialog.querySelector('h2').textContent = note ? 'Удалить заметку?' : 'Удалить папку?';
    dialog.querySelector('.delete-message').textContent = note ? title(note) : entry.folder;
    dialog.querySelector('.delete-hint').textContent = note ? 'Восстановить её не получится.' : 'Вложенные заметки и папки тоже будут удалены.';
    dialog.querySelector('[data-action="confirm-delete"]').textContent = note ? 'Удалить заметку' : 'Удалить папку';
    dialog.showModal();
  }

  openLink(target) {
    const note = resolveNote(this.store.notes, target, this.store.active);
    if (note) { this.openNote(note.id); return; }
    if (!this.store.editable) return;
    const parts = target.replace(/\.md$/i, '').split('/').map((part) => part.trim()).filter(Boolean);
    const name = parts.pop();
    if (!name || name.length > 200) return;
    const folder = target.includes('/') ? parts.join('/') : this.store.active.folder;
    const ambiguous = this.store.notes.some((item) => {
      const candidate = target.includes('/') ? notePath(item) : title(item);
      const expected = target.includes('/') ? [folder, name].filter(Boolean).join('/') : name;
      return candidate.normalize('NFC').toLocaleLowerCase('ru') === expected.normalize('NFC').toLocaleLowerCase('ru');
    });
    if (ambiguous) {
      this.query = name;
      this.tag = '';
      this.pinned = false;
      this.mobileEditor = false;
      this.shadowRoot.querySelector('.search input').value = name;
      this.render();
      return;
    }
    this.mode = 'edit';
    this.openNote(this.store.create(name, folder).id);
    this.shadowRoot.querySelector('.note-body').focus();
  }

  insertLink(path) {
    const textarea = this.shadowRoot.querySelector('.note-body');
    const end = textarea.selectionStart;
    const match = textarea.value.slice(0, end).match(/\[\[([^\[\]\n|]*)$/);
    if (!match) return;
    textarea.setRangeText(`[[/${path}]]`, match.index, end, 'end');
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  exportNote() {
    const note = this.store.active;
    const url = URL.createObjectURL(new Blob([note.body], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title(note).replace(/[<>:"/\\|?*]/g, '_')}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  format(kind) {
    const textarea = this.shadowRoot.querySelector('.note-body');
    if (!textarea || this.mode !== 'edit') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    if (kind === 'heading' || kind === 'checklist') {
      const position = textarea.value.lastIndexOf('\n', start - 1) + 1;
      textarea.setRangeText(kind === 'heading' ? '## ' : '- [ ] ', position, position, 'end');
    } else {
      if (kind === 'wiki' && !selected) {
        textarea.setRangeText('[[', start, end, 'end');
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const wrappers = { bold: ['**', '**'], italic: ['*', '*'], code: ['`', '`'], link: ['[', '](https://example.com)'], wiki: ['[[', ']]'] };
      const [before, after] = wrappers[kind];
      const text = selected || (kind === 'link' ? 'текст ссылки' : 'текст');
      textarea.setRangeText(`${before}${text}${after}`, start, end, 'end');
      textarea.setSelectionRange(start + before.length, start + before.length + text.length);
    }
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

if (!customElements.get('shtab-notes')) customElements.define('shtab-notes', NotesElement);
