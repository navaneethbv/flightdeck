function workspaceNode(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = String(content);
  return result;
}


function sameWorkspaceNote(left, right) {
  return left && right && left.version === right.version && left.title === right.title && left.body === right.body;
}

function workspaceCell(value, type) {
  if (value === null || value === undefined) return '-';
  if (type === 'boolean') return String(Boolean(value));
  return String(value);
}

/* Project workspace. Resource content is always rendered as text. */
globalThis.createWorkspace = function createWorkspace({ root, missionRoot, request, refresh, onLogs, onPlaybook }) {
  const labels = { notes: 'Notes', tables: 'Tables', worktrees: 'Worktrees', sessions: 'Sessions', playbooks: 'Playbooks', argus: 'Argus fleets' };
  const descriptions = {
    notes: 'Project knowledge, ready to read and edit.',
    tables: 'Inspect schemas and browse saved rows.',
    worktrees: 'Review branch status and tracked changes.',
    sessions: 'Open a session to inspect its output.',
    playbooks: 'Run a project workflow with the existing approval controls.',
  };
  let section = 'argus';
  let state = {};
  let selected = null;
  let draft = null;
  let saving = false;
  let generation = 0;
  let offset = 0;

  function button(label, action, primary = false) {
    const result = workspaceNode('button', `btn-action${primary ? ' primary' : ''}`, label);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  }

  const heading = workspaceNode('h1', 'workspace-title');
  const subtitle = workspaceNode('p', 'workspace-subtitle');
  const headingText = workspaceNode('div');
  headingText.append(heading, subtitle);
  const newNote = button('New note', () => openNewNote(), true);
  const header = workspaceNode('header', 'workspace-header');
  header.append(headingText, newNote);
  const search = workspaceNode('input', 'custom-input');
  search.type = 'search';
  search.id = 'resource-search';
  search.setAttribute('aria-label', 'Search workspace resources');
  search.placeholder = 'Search resources...';
  search.addEventListener('input', renderList);
  const list = workspaceNode('div', 'workspace-resource-list');
  list.setAttribute('aria-label', 'Workspace resources');
  const sidebar = workspaceNode('div', 'workspace-browser');
  sidebar.append(search, list);
  const detail = workspaceNode('section', 'workspace-detail');
  detail.setAttribute('aria-label', 'Resource details');
  const layout = workspaceNode('div', 'workspace-layout');
  layout.append(sidebar, detail);
  root.append(header, layout);

  function dirty() {
    if (!draft) return false;
    return draft.title !== (draft.original?.title ?? '') || draft.body !== (draft.original?.body ?? '');
  }

  function canLeave() {
    if (saving) return false;
    return !dirty() || window.confirm('Discard unsaved note changes?');
  }

  function navigate(next) {
    if (!Object.hasOwn(labels, next)) return false;
    if (section === next) return true;
    if (!canLeave()) return false;
    generation++;
    section = next;
    selected = null;
    draft = null;
    search.value = '';
    root.classList.toggle('hidden', next === 'argus');
    missionRoot.classList.toggle('hidden', next !== 'argus');
    heading.textContent = labels[next];
    subtitle.textContent = descriptions[next] || '';
    newNote.hidden = next !== 'notes';
    renderList();
    emptyDetail();
    return true;
  }

  function resources() {
    return (state[section] || []).map((item) => {
      if (typeof item === 'string') return { id: item, title: item, caption: 'Workflow' };
      if (section === 'notes') return { id: item.id, title: item.title, caption: `Version ${item.version}`, search: item.body };
      if (section === 'tables') return { id: item.name, title: item.name, caption: `${item.columns.length} columns` };
      if (section === 'worktrees') return { id: item.name, title: item.name, caption: item.branch };
      return { id: item.id, title: item.name, caption: `${item.harness} · ${item.status}` };
    });
  }

  function renderList() {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.resource : null;
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const items = resources().filter((item) => [item.title, item.caption, item.search].some((value) => String(value || '').toLowerCase().includes(query)));
    if (!items.length) {
      list.append(workspaceNode('p', 'workspace-empty', query ? 'No matching resources.' : `No ${section} yet.`));
      return;
    }
    for (const item of items) {
      const entry = button('', () => openResource(item.id));
      entry.className = 'workspace-resource';
      entry.dataset.resource = item.id;
      entry.setAttribute('aria-pressed', String(selected === item.id));
      entry.append(workspaceNode('strong', '', item.title || '(untitled)'), workspaceNode('span', '', item.caption));
      list.append(entry);
      if (item.id === focused) entry.focus({ preventScroll: true });
    }
  }

  function emptyDetail() {
    detail.replaceChildren(workspaceNode('p', 'workspace-empty', section === 'notes' ? 'Select a note or create one to get started.' : 'Select a resource to inspect it.'));
  }

  function message(text, error = false) {
    const result = workspaceNode('p', error ? 'workspace-error' : 'workspace-empty', text);
    result.setAttribute('role', error ? 'alert' : 'status');
    return result;
  }

  async function openResource(id) {
    if (section === 'sessions') {
      const session = (state.sessions || []).find((item) => item.id === id);
      if (session) onLogs(id, session.name);
      return;
    }
    if (!canLeave()) return;
    draft = null;
    selected = id;
    offset = 0;
    renderList();
    if (section === 'playbooks') {
      detail.replaceChildren(workspaceNode('h2', '', id), workspaceNode('p', 'workspace-subtitle', 'This workflow runs in the served project. Operations that need approval will prompt before execution.'));
      const run = button('Run workflow', () => onPlaybook(run, id), true);
      detail.append(run);
      return;
    }
    await loadDetail();
  }

  async function loadDetail() {
    const ticket = ++generation;
    detail.replaceChildren(message('Loading...'));
    const suffix = section === 'tables' ? `?offset=${offset}&limit=50` : '';
    try {
      const result = await request(`/api/workspace/${section}/${encodeURIComponent(selected)}${suffix}`);
      if (ticket !== generation) return;
      if (section === 'notes') {
        draft = { title: result.title, body: result.body, original: result };
        renderEditor();
      } else if (section === 'tables') {
        renderTable(result);
      } else if (section === 'worktrees') {
        renderWorktree(result);
      }
    } catch (error) {
      if (ticket !== generation) return;
      detail.replaceChildren(message(error.message, true), button('Try again', loadDetail));
    }
  }

  function openNewNote() {
    if (!canLeave()) return;
    generation++;
    selected = null;
    draft = { title: '', body: '', original: null };
    renderList();
    renderEditor();
    detail.querySelector('#workspace-note-title')?.focus();
  }

  function setNoteStatus() {
    const status = detail.querySelector('#workspace-note-status');
    const save = detail.querySelector('#workspace-note-save');
    if (status) status.textContent = dirty() ? 'Unsaved changes' : `Saved · Version ${draft?.original?.version ?? '-'}`;
    if (save) save.disabled = saving || !dirty() || !draft.title.trim();
  }

  function renderEditor() {
    const titleLabel = workspaceNode('label', 'workspace-field', 'Title');
    titleLabel.htmlFor = 'workspace-note-title';
    const title = workspaceNode('input', 'custom-input');
    title.id = 'workspace-note-title';
    title.value = draft.title;
    title.required = true;
    const bodyLabel = workspaceNode('label', 'workspace-field', 'Body (Markdown)');
    bodyLabel.htmlFor = 'workspace-note-body';
    const body = workspaceNode('textarea', 'custom-textarea workspace-note-body');
    body.id = 'workspace-note-body';
    body.value = draft.body;
    body.spellcheck = false;
    title.addEventListener('input', () => { draft.title = title.value; setNoteStatus(); });
    body.addEventListener('input', () => { draft.body = body.value; setNoteStatus(); });
    const status = workspaceNode('span', 'workspace-note-status');
    status.id = 'workspace-note-status';
    status.setAttribute('role', 'status');
    const save = button('Save note', saveNote, true);
    save.id = 'workspace-note-save';
    const discard = button(draft.original ? 'Reload saved note' : 'Discard draft', () => {
      if (!canLeave()) return;
      if (draft.original) { draft = null; loadDetail(); }
      else { draft = null; emptyDetail(); }
    });
    const toolbar = workspaceNode('div', 'workspace-editor-actions');
    toolbar.append(save, discard, status);
    const error = workspaceNode('p', 'workspace-error');
    error.id = 'workspace-note-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    detail.replaceChildren(titleLabel, title, bodyLabel, body, toolbar, error);
    setNoteStatus();
  }

  async function saveNote() {
    if (!draft || saving || !dirty() || !draft.title.trim()) return;
    saving = true;
    const current = draft;
    const original = current.original;
    for (const input of detail.querySelectorAll('input, textarea, button')) input.disabled = true;
    const status = detail.querySelector('#workspace-note-status');
    status.textContent = 'Saving...';
    try {
      const note = await request(original ? `/api/workspace/notes/${encodeURIComponent(original.id)}` : '/api/workspace/notes', {
        method: original ? 'PATCH' : 'POST',
        body: JSON.stringify({ title: current.title, body: current.body, ...(original ? { expected: { version: original.version, title: original.title, body: original.body } } : {}) }),
      });
      draft = { title: note.title, body: note.body, original: note };
      selected = note.id;
      renderEditor();
      refresh();
    } catch (error) {
      const errorBox = detail.querySelector('#workspace-note-error');
      errorBox.textContent = error.status === 409 ? 'This note changed elsewhere. Your draft is preserved. Copy your changes, then reload the saved note to reconcile them.' : `Save failed: ${error.message}`;
      errorBox.hidden = false;
    } finally {
      saving = false;
      for (const input of detail.querySelectorAll('input, textarea, button')) input.disabled = false;
      setNoteStatus();
    }
  }

  function detailHeader(title, description) {
    const toolbar = workspaceNode('div', 'workspace-detail-header');
    toolbar.append(workspaceNode('h2', '', title), button('Refresh', loadDetail));
    detail.replaceChildren(toolbar, workspaceNode('p', 'workspace-subtitle', description));
  }

  function renderTable({ table, rows, hasMore, offset: pageOffset }) {
    detailHeader(table.name, 'Read-only data. Rows are ordered by row ID.');
    const columns = [{ name: 'rowid', type: 'ID' }, ...table.columns];
    const grid = workspaceNode('table', 'workspace-table');
    const caption = workspaceNode('caption', 'workspace-sr-only', `${table.name} rows`);
    const head = workspaceNode('thead');
    const headers = workspaceNode('tr');
    for (const column of columns) {
      const cell = workspaceNode('th');
      cell.scope = 'col';
      cell.append(workspaceNode('span', '', column.name), workspaceNode('small', '', column.type));
      headers.append(cell);
    }
    head.append(headers);
    const body = workspaceNode('tbody');
    for (const row of rows) {
      const tr = workspaceNode('tr');
      for (const column of columns) {
        const value = row[column.name];
        tr.append(workspaceNode('td', '', workspaceCell(value, column.type)));
      }
      body.append(tr);
    }
    grid.append(caption, head, body);
    const scroll = workspaceNode('div', 'workspace-table-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('aria-label', 'Scrollable table');
    scroll.append(grid);
    detail.append(scroll);
    if (!rows.length) detail.append(message('This page has no rows.'));
    const previous = button('Previous', () => { offset = Math.max(0, pageOffset - 50); return loadDetail(); });
    previous.disabled = pageOffset === 0;
    const next = button('Next', () => { offset = pageOffset + 50; return loadDetail(); });
    next.disabled = !hasMore;
    const pager = workspaceNode('div', 'workspace-pagination');
    pager.append(previous, workspaceNode('span', '', rows.length ? `Rows ${pageOffset + 1}-${pageOffset + rows.length}` : '0 rows'), next);
    detail.append(pager);
  }

  function fileList(title, files) {
    const section = workspaceNode('section', 'workspace-files');
    section.append(workspaceNode('h3', '', `${title} (${files.length})`));
    const list = workspaceNode('ul');
    for (const file of files) list.append(workspaceNode('li', '', file));
    if (!files.length) list.append(workspaceNode('li', 'text-dim', 'None'));
    section.append(list);
    return section;
  }

  function renderWorktree({ status, diff }) {
    detailHeader(status.name, status.path);
    const meta = workspaceNode('div', 'workspace-worktree-meta');
    meta.append(workspaceNode('code', '', status.branch), workspaceNode('span', status.clean ? 'workspace-clean' : 'workspace-dirty', status.clean ? 'Clean' : 'Uncommitted changes'));
    detail.append(meta, fileList('Modified files', status.modified), fileList('Untracked files', status.untracked));
    detail.append(workspaceNode('h3', '', `Diff (${diff.filesChanged} files)`), workspaceNode('p', 'workspace-subtitle', diff.comparison || 'Tracked changes; untracked files are listed separately.'));
    const content = workspaceNode('pre', 'workspace-diff', diff.diff || 'No tracked changes.');
    content.tabIndex = 0;
    content.setAttribute('aria-label', 'Worktree diff');
    detail.append(content);
  }

  function update(next) {
    state = next;
    if (section === 'argus') return;
    renderList();
    if (section !== 'notes' || !draft?.original || saving) return;
    const latest = (state.notes || []).find((note) => note.id === draft.original.id);
    if (sameWorkspaceNote(latest, draft.original) || (latest && latest.version < draft.original.version)) return;
    if (!dirty() && latest) {
      draft = { title: latest.title, body: latest.body, original: latest };
      renderEditor();
      return;
    }
    const error = detail.querySelector('#workspace-note-error');
    if (error) {
      error.textContent = latest ? 'This note changed elsewhere. Your draft is preserved; reload the saved note before reconciling your changes.' : 'This note was deleted elsewhere. Your draft is preserved so you can copy it.';
      error.hidden = false;
    }
  }

  window.addEventListener('beforeunload', (event) => {
    if (dirty() || saving) {
      event.preventDefault();
    }
  });

  function reset() {
    generation++;
    draft = null;
    selected = null;
    section = 'argus';
    root.classList.add('hidden');
    missionRoot.classList.remove('hidden');
    emptyDetail();
  }

  return { get section() { return section; }, navigate, update, canLeave, reset };
};
