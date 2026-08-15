// Flightdeck web control plane client.
//
// Everything rendered here comes from /api/state. There are no sample rows and
// no illustrative values: a field the backend does not measure renders as an
// inert dash, and a failed request renders as an error. See the spec section
// "Prohibited: fabricated data".

const NO_VALUE = '-';

let capabilityToken = '';
let pendingConfirmResolve = null;
let actedConfirmId = null;

/**
 * The capability token is minted per server session and printed with the URL.
 * It rides the URL fragment, which is never sent to the server, so the client
 * reads it here and presents it on every /api/* call.
 */
function readCapabilityToken() {
  const m = /[#&]token=([^&]+)/.exec(window.location.href);
  capabilityToken = m ? decodeURIComponent(m[1]) : '';
}

/** Headers for /api/* calls: the token rides the X-Flightdeck-Token header. */
function authedHeaders(extra = {}) {
  const headers = { ...extra };
  if (capabilityToken) headers['X-Flightdeck-Token'] = capabilityToken;
  return headers;
}

/** /api/events is the one endpoint that reads the token from the query string. */
function eventsUrl() {
  const url = '/api/events';
  if (!capabilityToken) return url;
  return `${url}?token=${encodeURIComponent(capabilityToken)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let state = {
  projectRoot: '',
  projectName: '',
  sessions: [],
  argus: [],
  notes: [],
  tables: [],
  messages: [],
  watchdog: { hungSessions: [] },
  worktrees: [],
  playbooks: [],
  defaultHarness: '',
};

let activeSessionIdForLogs = null;
let selectedFleetId = null;

function el(id) {
  return document.getElementById(id);
}

/** Set an element's text, tolerating a DOM that does not contain it. */
function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

/** Set a form control's value, tolerating a DOM that does not contain it. */
function setControlValue(id, value) {
  const node = el(id);
  if (node) node.value = String(value);
}

function text(value) {
  return value === null || value === undefined || value === '' ? NO_VALUE : String(value);
}

/**
 * Spend and progress come from session_telemetry. A null field renders as a
 * dash; the harness did not report it. No default, average, or estimate ever
 * substitutes for a measured value.
 */
function formatSpend(costUsd) {
  if (costUsd === null || costUsd === undefined) return NO_VALUE;
  if (costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

function formatProgress(progress) {
  if (progress === null || progress === undefined) return NO_VALUE;
  return `${progress}%`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function relativeTime(ms) {
  if (!ms) return NO_VALUE;
  const delta = Date.now() - ms;
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------- data layer

async function fetchState() {
  try {
    const res = await fetch('/api/state', { headers: authedHeaders() });
    if (!res.ok) {
      showError(`state request failed: ${res.status}`);
      return;
    }
    state = await res.json();
    clearError();
    renderUI();
  } catch (err) {
    showError(err.message);
  }
}

function showError(message) {
  const banner = el('error-banner');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function clearError() {
  el('error-banner')?.classList.add('hidden');
}

/** What a failed response said, falling back to its bare status when it said nothing. */
function responseError(payload, res) {
  return payload.error ?? `HTTP ${res.status}`;
}

function initSSE() {
  const evt = new EventSource(eventsUrl());
  evt.onmessage = (e) => {
    try {
      if (JSON.parse(e.data).type === 'update') fetchState();
    } catch {
      // A malformed frame is not worth surfacing; the next poll recovers.
    }
  };
}

// ----------------------------------------------------------------- rendering

function renderUI() {
  renderTitle();
  renderProjectTree();
  renderMission();
  renderFleet();
  renderToolkit();
  renderReplyTargets();
}

function renderTitle() {
  const title = el('project-title-label');
  if (title) title.textContent = state.projectName || NO_VALUE;
  const root = el('project-root-label');
  if (root) root.textContent = state.projectRoot || NO_VALUE;
  const harness = el('default-harness-label');
  if (harness) harness.textContent = `harness: ${text(state.defaultHarness)}`;
}

/** Real sections of the served project. One project per server process. */
function renderProjectTree() {
  const tree = el('projects-tree');
  if (!tree) return;

  const sections = [
    { key: 'sessions', icon: '🖥', label: 'Sessions', count: state.sessions.length },
    { key: 'worktrees', icon: '🌿', label: 'Worktrees', count: state.worktrees.length },
    { key: 'notes', icon: '📝', label: 'Notes', count: state.notes.length },
    { key: 'tables', icon: '📊', label: 'Tables', count: state.tables.length },
    { key: 'playbooks', icon: '⚡', label: 'Playbooks', count: state.playbooks.length },
    { key: 'argus', icon: '👁', label: 'Argus fleets', count: state.argus.length },
  ];

  tree.innerHTML = `
    <div class="tree-group active-group">
      <div class="tree-item group-header">
        <span class="chevron">▼</span>
        <span class="folder-icon">📁</span>
        <span class="item-name font-bold">${escapeHtml(state.projectName || NO_VALUE)}</span>
      </div>
      <div class="tree-children">
        ${sections
          .map(
            (s) => `
          <div class="tree-item indent-1" data-section="${s.key}">
            <span class="icon">${s.icon}</span>
            <span class="item-name">${s.label}</span>
            <span class="count-pill">${s.count}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>
  `;
}

/**
 * The Mission pane reflects the selected Argus fleet and its mission note.
 * With no fleet configured there is nothing real to show, so we say so rather
 * than rendering a specimen mission.
 */
function renderMission() {
  const fleet = selectedFleet();
  selectedFleetId = fleet ? fleet.id : null;

  toggleMissionCards(Boolean(fleet));
  if (!fleet) return;

  setText('fleet-title', fleet.name || NO_VALUE);
  setText('fleet-status', text(fleet.status));
  renderFleetControls(fleet);
  renderMissionNote(fleet);
  renderPulseProgress(fleet);
  renderLaws(fleet);
}

/** The fleet the user picked, falling back to the first when that pick is stale. */
function selectedFleet() {
  const fleets = state.argus ?? [];
  return fleets.find((f) => f.id === selectedFleetId) ?? fleets[0] ?? null;
}

/**
 * The pulse and permissions cards describe a fleet. With no fleet they have
 * nothing to say, so they are hidden rather than shown as empty shells.
 */
function toggleMissionCards(hasFleet) {
  el('mission-empty')?.classList.toggle('hidden', hasFleet);
  el('mission-body')?.classList.toggle('hidden', !hasFleet);
  el('pulse-card')?.classList.toggle('hidden', !hasFleet);
  el('laws-card')?.classList.toggle('hidden', !hasFleet);
}

/** Heartbeat, child limit and harness controls mirror the fleet's own settings. */
function renderFleetControls(fleet) {
  if (fleet.pulseSec) {
    const minutes = Math.max(1, Math.round(fleet.pulseSec / 60));
    setText('val-heartbeat', `${minutes}m`);
    setControlValue('slider-heartbeat', minutes);
  }
  if (fleet.childLimit) {
    setText('val-children', String(fleet.childLimit));
    setControlValue('slider-children', fleet.childLimit);
  }
  if (state.defaultHarness) setControlValue('select-child-harness', state.defaultHarness);
}

/** The mission note is shown as stored, or reported missing. It is never invented. */
function renderMissionNote(fleet) {
  const note = (state.notes ?? []).find((n) => n.id === fleet.missionNoteId) ?? null;
  setText('mission-text', note?.body ? note.body : 'Mission note is empty or missing.');
  setText('mission-note-label', note ? note.title : NO_VALUE);
}

/** A pulse row's optional detail, escaped and space-prefixed, or nothing at all. */
function detailSuffix(detail) {
  return detail ? ` ${escapeHtml(detail)}` : '';
}

/** Recent pulse rows are real history; there is no standing hardcoded routine. */
function renderPulseProgress(fleet) {
  const list = el('pulse-actions-list');
  if (!list) return;
  const rows = fleet.recentProgress ?? [];
  if (rows.length === 0) {
    list.innerHTML = `<p class="empty-state">No pulses recorded yet. Last pulse: ${escapeHtml(
      fleet.lastPulseAt ? relativeTime(fleet.lastPulseAt) : NO_VALUE
    )}</p>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (p) => `
      <div class="pulse-action-item">
        <span class="bullet-arrow">▶</span>
        <div class="action-text">
          <strong>${escapeHtml(p.kind ?? NO_VALUE)}</strong>
          ${detailSuffix(p.detail)}
          <div class="sub-step">${escapeHtml(relativeTime(p.createdAt))}</div>
        </div>
      </div>`
    )
    .join('');
}

function renderLaws(fleet) {
  const laws = el('laws-content');
  if (!laws) return;
  laws.innerHTML = `
    <ul class="laws-list">
      <li>Child limit: <strong>${escapeHtml(text(fleet.childLimit))}</strong></li>
      <li>Risky tools (playbooks, SSH, HTTP): <strong>${fleet.riskyTools ? 'granted' : 'denied'}</strong></li>
      <li>Children run in isolated Git worktrees and cannot spawn a further generation.</li>
    </ul>
  `;
}

/**
 * One card per real session. Model, spend, and progress come from
 * session_telemetry; whatever the harness did not report renders as a dash.
 */
function renderFleet() {
  const container = el('sessions-container');
  if (!container) return;

  const sessions = state.sessions ?? [];
  const hung = new Set((state.watchdog?.hungSessions ?? []).map((s) => s.id ?? s));

  const count = el('fleet-child-count');
  if (count) count.textContent = String(sessions.length);

  if (sessions.length === 0) {
    container.innerHTML = `<p class="empty-state">No sessions. Start one with <code>deck session start</code>.</p>`;
    return;
  }

  container.innerHTML = '';
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.id = s.id;

    const status = hung.has(s.id) ? 'Hung' : s.status;
    const where = s.worktree ? s.worktree.split('/').pop() : 'project root';
    const telemetry = s.telemetry ?? {};
    const model = text(telemetry.model);
    const spend = formatSpend(telemetry.costUsd);
    const progress = formatProgress(telemetry.progress);
    const telemetryNote =
      model === NO_VALUE && spend === NO_VALUE && progress === NO_VALUE
        ? 'Model, spend, and progress were not reported.'
        : 'Model, spend, and progress as reported by the harness.';

    card.innerHTML = `
      <div class="session-card-header">
        <div class="session-card-name-row">
          <span class="avatar-xs harness-${escapeHtml(s.harness)}"></span>
          <span class="session-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
        </div>
        <span class="session-percent" title="${escapeHtml(telemetryNote)}">${escapeHtml(progress)}</span>
      </div>
      <div class="session-card-meta">
        <span class="session-status-badge ${escapeHtml(status.toLowerCase())}">
          <span class="status-dot">●</span> ${escapeHtml(status)}
        </span>
        <span class="session-model-badge" title="${escapeHtml(telemetryNote)}">
          ${escapeHtml(model)} · ${escapeHtml(spend)}
        </span>
      </div>
      <div class="session-card-footer text-dim">
        ${escapeHtml(where)} · ${escapeHtml(relativeTime(s.lastActivityAt))}
      </div>
    `;

    card.addEventListener('click', () => openLogsModal(s.id, s.name));
    container.appendChild(card);
  }
}

/** One button per playbook that actually resolves on this project. */
function renderToolkit() {
  const grid = el('toolkit-grid');
  if (!grid) return;
  const playbooks = state.playbooks ?? [];

  if (playbooks.length === 0) {
    grid.innerHTML = `<p class="empty-state">No playbooks. Add one under <code>.flightdeck/playbooks/</code>.</p>`;
    return;
  }

  grid.innerHTML = '';
  for (const name of playbooks) {
    const btn = document.createElement('button');
    btn.className = 'toolkit-btn';
    btn.dataset.action = name;
    btn.innerHTML = `<span class="play-icon">▷</span> ${escapeHtml(name)}`;
    btn.addEventListener('click', () => runToolkitAction(btn, name));
    grid.appendChild(btn);
  }
}

/** A toolkit run that reached a success state. */
function toolkitSuccess(btn) {
  btn.innerHTML = `<span class="play-icon ok">✓</span> Done`;
}

/** A toolkit run that errored: rendered as a visible error, never as success. */
function toolkitFailure(btn, message) {
  btn.innerHTML = `<span class="play-icon err">✕</span> Failed`;
  showError(message);
}

async function runToolkitAction(btn, name) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="play-icon">⏳</span> Running...`;
  try {
    const res = await fetch('/api/toolkit/run', {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: name }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toolkitFailure(btn, `playbook "${name}" failed: ${responseError(payload, res)}`);
      return;
    }
    const outcome = await pollToolkitRun(payload.runId);
    if (outcome.ok) {
      toolkitSuccess(btn);
    } else {
      toolkitFailure(btn, `playbook "${name}" failed: ${outcome.error}`);
    }
  } catch (err) {
    toolkitFailure(btn, `playbook "${name}" failed: ${err.message}`);
  } finally {
    setTimeout(() => {
      btn.innerHTML = original;
      btn.disabled = false;
    }, 2500);
  }
}

/**
 * Follow a toolkit run to a terminal state. A run that is awaiting a
 * confirmation suspends here and resumes only after the user decides in the
 * confirmation modal.
 */
async function pollToolkitRun(runId) {
  for (;;) {
    const res = await fetch(`/api/toolkit/run/${encodeURIComponent(runId)}`, {
      headers: authedHeaders(),
    });
    const run = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: responseError(run, res) };
    if (run.status === 'succeeded') return { ok: true };
    if (run.status === 'failed') return { ok: false, error: run.error || 'run failed' };
    if (
      run.status === 'awaiting_confirmation' &&
      run.confirm &&
      run.confirm.id &&
      run.confirm.id !== actedConfirmId
    ) {
      actedConfirmId = run.confirm.id;
      const approved = await requestConfirm(run.confirm.prompt || 'Approve this action?');
      await confirmDecision(run.confirm.id, run.confirm.operation, approved);
      continue;
    }
    await sleep(400);
  }
}

function ensureConfirmModal() {
  if (el('modal-confirm')) return;
  const div = document.createElement('div');
  div.id = 'modal-confirm';
  div.className = 'modal-backdrop hidden';
  div.innerHTML = `
    <div class="modal-window">
      <div class="modal-header">
        <h3>Confirm action</h3>
      </div>
      <div class="modal-body">
        <p class="confirm-prompt" id="confirm-prompt"></p>
      </div>
      <div class="modal-footer">
        <button class="btn-action" id="btn-deny-confirm">Deny</button>
        <button class="btn-action primary" id="btn-approve-confirm">Approve</button>
      </div>
    </div>`;
  document.body.appendChild(div);
  el('btn-approve-confirm').addEventListener('click', () => {
    el('modal-confirm').classList.add('hidden');
    if (pendingConfirmResolve) {
      const resolve = pendingConfirmResolve;
      pendingConfirmResolve = null;
      resolve(true);
    }
  });
  el('btn-deny-confirm').addEventListener('click', () => {
    el('modal-confirm').classList.add('hidden');
    if (pendingConfirmResolve) {
      const resolve = pendingConfirmResolve;
      pendingConfirmResolve = null;
      resolve(false);
    }
  });
}

/** Show the confirmation modal and wait for the human's decision. */
function requestConfirm(prompt) {
  ensureConfirmModal();
  el('confirm-prompt').textContent = prompt;
  el('modal-confirm').classList.remove('hidden');
  return new Promise((resolve) => {
    pendingConfirmResolve = resolve;
  });
}

/** Post a decision for a pending confirmation bound to its operation. */
async function confirmDecision(confirmId, operation, ok) {
  await fetch('/api/toolkit/confirm', {
    method: 'POST',
    headers: authedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ confirmId, operation, ok }),
  });
}

function renderReplyTargets() {
  const target = el('reply-target');
  if (!target) return;
  const prev = target.value;
  target.innerHTML = '<option value="">Broadcast to fleet (*)</option>';
  for (const s of state.sessions ?? []) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} (${s.id.slice(0, 8)})`;
    target.appendChild(opt);
  }
  target.value = prev;
}

// -------------------------------------------------------------------- modals

function openLogsModal(id, title) {
  activeSessionIdForLogs = id;
  const titleElem = el('logs-modal-title');
  const term = el('logs-terminal-view');
  if (titleElem) titleElem.textContent = `Logs: ${title || id}`;
  if (term) term.textContent = 'Loading...';
  el('modal-logs')?.classList.remove('hidden');
  loadLogs(id);
}

async function loadLogs(id) {
  const term = el('logs-terminal-view');
  if (!term) return;
  try {
    const res = await fetch(`/api/sessions/${id}/logs`, { headers: authedHeaders() });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      term.textContent = `Could not read logs: ${responseError(payload, res)}`;
      return;
    }
    const data = await res.json();
    term.textContent = data.logs ? data.logs : 'No log output recorded for this session yet.';
  } catch (err) {
    term.textContent = `Could not read logs: ${err.message}`;
  }
}

function bindModal(openIds, modalId, closeIds) {
  const modal = el(modalId);
  if (!modal) return;
  for (const id of openIds) el(id)?.addEventListener('click', () => modal.classList.remove('hidden'));
  for (const id of closeIds) el(id)?.addEventListener('click', () => modal.classList.add('hidden'));
}

function setupEventHandlers() {
  bindModal(['btn-reply-now'], 'modal-reply', ['btn-close-reply', 'btn-cancel-reply']);
  bindModal(
    ['btn-spawn-session', 'btn-open-session'],
    'modal-new-session',
    ['btn-close-new-session', 'btn-cancel-new-session']
  );
  bindModal([], 'modal-logs', ['btn-close-logs', 'btn-dismiss-logs']);

  el('btn-refresh-logs')?.addEventListener('click', () => {
    if (activeSessionIdForLogs) loadLogs(activeSessionIdForLogs);
  });

  el('btn-view-logs')?.addEventListener('click', () => {
    const first = (state.sessions ?? [])[0];
    if (!first) {
      showError('No sessions to show logs for.');
      return;
    }
    openLogsModal(first.id, first.name);
  });

  el('btn-send-reply')?.addEventListener('click', async () => {
    const btn = el('btn-send-reply');
    const body = el('reply-text')?.value;
    if (!body) return;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: authedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          toSession: el('reply-target')?.value || null,
          body,
          fromSession: 'user',
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      el('modal-reply')?.classList.add('hidden');
      el('reply-text').value = '';
      fetchState();
    } catch (err) {
      showError(`send failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send message';
    }
  });

  el('btn-confirm-new-session')?.addEventListener('click', async () => {
    const btn = el('btn-confirm-new-session');
    const name = el('new-session-name')?.value;
    if (!name) {
      showError('Session name is required.');
      return;
    }
    const task = el('new-session-task')?.value || '';
    btn.disabled = true;
    btn.textContent = 'Launching...';
    try {
      const res = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: authedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name,
          harness: el('new-session-harness')?.value || state.defaultHarness,
          task,
          headless: el('new-session-headless')?.checked ?? true,
          prompt: task,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      el('modal-new-session')?.classList.add('hidden');
      el('new-session-name').value = '';
      el('new-session-task').value = '';
      fetchState();
    } catch (err) {
      showError(`launch failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Launch session';
    }
  });

  el('project-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    for (const item of document.querySelectorAll('.tree-item')) {
      item.style.display = !q || item.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    }
  });

  el('btn-refresh')?.addEventListener('click', fetchState);
}

document.addEventListener('DOMContentLoaded', () => {
  readCapabilityToken();
  setupEventHandlers();
  fetchState();
  initSSE();
  setInterval(fetchState, 4000);
});
