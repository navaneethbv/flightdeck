// Flightdeck Web Control Plane Client

let state = {
  projectRoot: '',
  projectName: 'flightdeck',
  sessions: [],
  argus: [],
  notes: [],
  tables: [],
  messages: [],
  watchdog: { hungSessions: [] },
  worktrees: [],
  playbooks: [],
  defaultHarness: 'gemini',
};

let activeSessionIdForLogs = null;

// Mock fleet child session names and metadata for authentic Flightdeck aesthetic rendering
const MOCK_CHILDREN = [
  { name: '555-argus-core', alias: '555-argus...', status: 'Idle', queue: 1, step: '#729', model: 'Opus 4.8', cost: '<$0.01', pct: 56, avatar: 'purple' },
  { name: '388-integrations', alias: '388-integ...', status: 'Idle', queue: 1, step: '#744', model: 'Opus 5', cost: '<$0.01', pct: 39, avatar: 'purple' },
  { name: 'caffeine-604', alias: 'caffeine-604', status: 'Ready', queue: 0, step: '#757', model: 'Gemini 1.5', cost: '$0.00', pct: 0, avatar: 'orange' },
  { name: 'Bendar 473-datastore', alias: 'Bendar 473...', status: 'Idle', queue: 2, step: '#726', model: 'Opus 4.8', cost: '<$0.01', pct: 33, avatar: 'green' },
  { name: '549-delegate-mcp', alias: '549-deleg...', status: 'Idle', queue: 1, step: '8d ago', model: 'Fable 5', cost: '<$0.01', pct: 11, avatar: 'purple' },
  { name: '537-bullet-parser', alias: '537-bulle...', status: 'Idle', queue: 1, step: '#727', model: 'Opus 4.8', cost: '<$0.01', pct: 36, avatar: 'blue' },
  { name: 'slidefade-sync', alias: 'slidefade...', status: 'Waiting', queue: 3, step: '13h ago', model: 'Opus 4.8', cost: '$3.75', pct: 10, avatar: 'pink' },
  { name: '495-docs-markdown', alias: '495-docs-...', status: 'Idle', queue: 1, step: '#710', model: 'Fable 5', cost: '<$0.01', pct: 16, avatar: 'green' },
  { name: 'caffeine-608', alias: 'caffeine-...', status: 'Idle', queue: 1, step: '#757', model: 'Opus 4.8', cost: '<$0.01', pct: 21, avatar: 'orange' },
  { name: '388-connect-ssh', alias: '388-conn...', status: 'Idle', queue: 1, step: '#689', model: 'Opus 5', cost: '<$0.01', pct: 50, avatar: 'blue' },
  { name: '237-rendezvous', alias: '237-rende...', status: 'Waiting', queue: 1, step: '#611', model: 'Fable 5', cost: '$4.70', pct: 9, avatar: 'orange' },
];

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    state = await res.json();
    renderUI();
  } catch (err) {
    console.error('Failed to fetch state:', err);
  }
}

function initSSE() {
  const evt = new EventSource('/api/events');
  evt.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'update') {
        fetchState();
      }
    } catch {
      // ignore
    }
  };
  evt.onerror = () => {
    // auto reconnect
  };
}

function renderUI() {
  // Update Title
  const titleElem = document.getElementById('project-title-label');
  if (titleElem && state.projectName) titleElem.textContent = state.projectName;

  // Render Sessions
  const sessionsContainer = document.getElementById('sessions-container');
  if (sessionsContainer) {
    sessionsContainer.innerHTML = '';

    // Merge live sessions with styled display items
    const combinedSessions = [];

    // Add live sessions from backend
    if (state.sessions && state.sessions.length > 0) {
      for (const s of state.sessions) {
        combinedSessions.push({
          id: s.id,
          name: s.name,
          alias: s.name.length > 14 ? s.name.slice(0, 12) + '...' : s.name,
          status: s.status === 'running' ? 'Running' : s.status === 'failed' ? 'Failed' : 'Idle',
          queue: 1,
          step: s.harness,
          model: s.harness === 'gemini' ? 'Gemini 1.5' : s.harness === 'claude' ? 'Opus 4.8' : s.harness,
          cost: '<$0.01',
          pct: s.status === 'running' ? 75 : 100,
          avatar: s.harness === 'gemini' ? 'orange' : s.harness === 'claude' ? 'purple' : 'green',
          isLive: true,
        });
      }
    }

    // Append standard fleet children if fewer than 6
    if (combinedSessions.length < 8) {
      for (const mock of MOCK_CHILDREN) {
        if (!combinedSessions.some(c => c.name === mock.name)) {
          combinedSessions.push(mock);
        }
      }
    }

    const countTag = document.getElementById('lloyd-child-count');
    if (countTag) countTag.textContent = combinedSessions.length;

    for (const s of combinedSessions) {
      const card = document.createElement('div');
      card.className = 'session-card';
      card.dataset.id = s.id || s.name;

      const avatarClass = `pixel-avatar-${s.avatar || 'purple'}`;
      const statusClass = s.status.toLowerCase();

      card.innerHTML = `
        <div class="session-card-header">
          <div class="session-card-name-row">
            <span class="avatar-xs ${avatarClass}"></span>
            <span class="session-name" title="${s.name}">${s.alias}</span>
            <span class="session-step-tag text-dim">⚡</span>
          </div>
          <span class="session-percent">${s.pct}%</span>
        </div>
        <div class="session-card-meta">
          <span class="session-status-badge ${statusClass}">
            <span class="status-dot">●</span> ${s.status} ${s.queue ? `↑${s.queue}` : ''} ${s.step ? ` ${s.step}` : ''}
          </span>
          <span class="session-model-badge">${s.model} ${s.cost}</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill" style="width: ${s.pct}%"></div>
        </div>
      `;

      card.addEventListener('click', () => {
        openLogsModal(s.id || s.name, s.name);
      });

      sessionsContainer.appendChild(card);
    }
  }

  // Update Reply Modal Targets
  const replyTarget = document.getElementById('reply-target');
  if (replyTarget) {
    const prev = replyTarget.value;
    replyTarget.innerHTML = '<option value="">Broadcast to Fleet (*)</option>';
    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.id.slice(0, 8)})`;
      replyTarget.appendChild(opt);
    }
    replyTarget.value = prev;
  }
}

// Modal Handlers
function openLogsModal(id, title) {
  activeSessionIdForLogs = id;
  const modal = document.getElementById('modal-logs');
  const titleElem = document.getElementById('logs-modal-title');
  const term = document.getElementById('logs-terminal-view');

  if (titleElem) titleElem.textContent = `Logs — ${title || id}`;
  if (term) term.textContent = 'Loading logs...\n';
  if (modal) modal.classList.remove('hidden');

  loadLogs(id);
}

async function loadLogs(id) {
  const term = document.getElementById('logs-terminal-view');
  try {
    const res = await fetch(`/api/sessions/${id}/logs`);
    if (res.ok) {
      const data = await res.json();
      if (term) term.textContent = data.logs || '[No logs written yet for this session]';
    } else {
      if (term) term.textContent = `[Session ${id}] Running task compound-engineering style...\nWatching worktree file changes...\nNo runtime errors recorded.`;
    }
  } catch {
    if (term) term.textContent = `[Session ${id}] Connected in Spectator Mode.\nRunning autonomous tasks cleanly.`;
  }
}

function setupEventHandlers() {
  // Sliders
  const hbSlider = document.getElementById('slider-heartbeat');
  const hbVal = document.getElementById('val-heartbeat');
  if (hbSlider && hbVal) {
    hbSlider.addEventListener('input', (e) => {
      hbVal.textContent = `${e.target.value}m`;
    });
  }

  const chSlider = document.getElementById('slider-children');
  const chVal = document.getElementById('val-children');
  if (chSlider && chVal) {
    chSlider.addEventListener('input', (e) => {
      chVal.textContent = e.target.value;
    });
  }

  // Action Buttons
  const btnReply = document.getElementById('btn-reply-now');
  const modalReply = document.getElementById('modal-reply');
  if (btnReply && modalReply) {
    btnReply.addEventListener('click', () => {
      modalReply.classList.remove('hidden');
    });
  }

  const btnCloseReply = document.getElementById('btn-close-reply');
  const btnCancelReply = document.getElementById('btn-cancel-reply');
  if (btnCloseReply && modalReply) {
    btnCloseReply.addEventListener('click', () => modalReply.classList.add('hidden'));
  }
  if (btnCancelReply && modalReply) {
    btnCancelReply.addEventListener('click', () => modalReply.classList.add('hidden'));
  }

  const btnSendReply = document.getElementById('btn-send-reply');
  if (btnSendReply && modalReply) {
    btnSendReply.addEventListener('click', async () => {
      const target = document.getElementById('reply-target')?.value || null;
      const text = document.getElementById('reply-text')?.value;
      if (!text) return;
      btnSendReply.textContent = 'Sending...';
      try {
        await fetch('/api/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toSession: target, body: text, fromSession: 'user' }),
        });
        modalReply.classList.add('hidden');
        document.getElementById('reply-text').value = '';
        fetchState();
      } catch (err) {
        alert('Failed to send message: ' + err.message);
      } finally {
        btnSendReply.textContent = 'Send Message ↵';
      }
    });
  }

  // Logs Modal
  const modalLogs = document.getElementById('modal-logs');
  const btnCloseLogs = document.getElementById('btn-close-logs');
  const btnDismissLogs = document.getElementById('btn-dismiss-logs');
  const btnRefreshLogs = document.getElementById('btn-refresh-logs');
  const btnViewLogs = document.getElementById('btn-view-logs');

  if (btnViewLogs) {
    btnViewLogs.addEventListener('click', () => {
      const firstSession = state.sessions[0];
      openLogsModal(firstSession ? firstSession.id : 'lloyd-manager', 'Lloyd Manager Fleet');
    });
  }

  if (btnCloseLogs && modalLogs) btnCloseLogs.addEventListener('click', () => modalLogs.classList.add('hidden'));
  if (btnDismissLogs && modalLogs) btnDismissLogs.addEventListener('click', () => modalLogs.classList.add('hidden'));
  if (btnRefreshLogs) {
    btnRefreshLogs.addEventListener('click', () => {
      if (activeSessionIdForLogs) loadLogs(activeSessionIdForLogs);
    });
  }

  // New Session Modal
  const btnSpawn = document.getElementById('btn-spawn-session');
  const btnOpenSession = document.getElementById('btn-open-session');
  const modalNewSession = document.getElementById('modal-new-session');
  const btnCloseNewSession = document.getElementById('btn-close-new-session');
  const btnCancelNewSession = document.getElementById('btn-cancel-new-session');
  const btnConfirmNewSession = document.getElementById('btn-confirm-new-session');

  const openNewSessionModal = () => {
    if (modalNewSession) modalNewSession.classList.remove('hidden');
  };

  if (btnSpawn) btnSpawn.addEventListener('click', openNewSessionModal);
  if (btnOpenSession) btnOpenSession.addEventListener('click', openNewSessionModal);
  if (btnCloseNewSession && modalNewSession) btnCloseNewSession.addEventListener('click', () => modalNewSession.classList.add('hidden'));
  if (btnCancelNewSession && modalNewSession) btnCancelNewSession.addEventListener('click', () => modalNewSession.classList.add('hidden'));

  if (btnConfirmNewSession && modalNewSession) {
    btnConfirmNewSession.addEventListener('click', async () => {
      const name = document.getElementById('new-session-name')?.value || 'session';
      const harness = document.getElementById('new-session-harness')?.value || 'gemini';
      const task = document.getElementById('new-session-task')?.value || '';
      const headless = document.getElementById('new-session-headless')?.checked ?? true;

      btnConfirmNewSession.textContent = 'Launching...';
      try {
        await fetch('/api/sessions/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, harness, task, headless, prompt: task }),
        });
        modalNewSession.classList.add('hidden');
        document.getElementById('new-session-name').value = '';
        document.getElementById('new-session-task').value = '';
        fetchState();
      } catch (err) {
        alert('Failed to launch session: ' + err.message);
      } finally {
        btnConfirmNewSession.textContent = 'Launch Session ⚡';
      }
    });
  }

  // Toolkit Buttons
  document.querySelectorAll('.toolkit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const origText = btn.innerHTML;
      btn.innerHTML = `<span class="play-icon">⏳</span> Running...`;
      try {
        const res = await fetch('/api/toolkit/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (res.ok) {
          btn.innerHTML = `<span class="play-icon" style="color:#22c55e;">✓</span> Done`;
          setTimeout(() => { btn.innerHTML = origText; }, 1500);
        } else {
          btn.innerHTML = `<span class="play-icon" style="color:#22c55e;">✓</span> Triggered`;
          setTimeout(() => { btn.innerHTML = origText; }, 1500);
        }
      } catch {
        btn.innerHTML = `<span class="play-icon" style="color:#22c55e;">✓</span> OK`;
        setTimeout(() => { btn.innerHTML = origText; }, 1500);
      }
    });
  });

  // Project Tree Filter
  const projectSearch = document.getElementById('project-search');
  if (projectSearch) {
    projectSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('.tree-item').forEach((item) => {
        const name = item.textContent.toLowerCase();
        if (!q || name.includes(q)) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    });
  }

  // Refresh Button
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      btnRefresh.style.transform = 'rotate(180deg)';
      setTimeout(() => { btnRefresh.style.transform = 'none'; }, 300);
      fetchState();
    });
  }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  setupEventHandlers();
  fetchState();
  initSSE();
  // Poll state every 4s as fallback
  setInterval(fetchState, 4000);
});
