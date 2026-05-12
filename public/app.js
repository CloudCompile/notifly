// ─── Constants ───────────────────────────────────────────────────────────────
const GH_API = 'https://api.github.com';
const POLLINATIONS_API = 'https://gen.pollinations.ai/v1/chat/completions';
const AI_MODEL = 'nova-fast';

const LS = {
  GITHUB_TOKEN:     'notifly:github_token',
  GITHUB_USER:      'notifly:github_user',
  POLLINATIONS_KEY: 'notifly:pollinations_key',
  NOTIFICATIONS:    'notifly:notifications',
  AI_LABELS:        'notifly:ai_labels',
  AI_PRIORITIES:    'notifly:ai_priorities',
  READ_STATE:       'notifly:read_state',
  DONE_STATE:       'notifly:done_state',
  LATEST_DIGEST:    'notifly:latest_digest',
  DISPLAY_PREFS:    'notifly:display_prefs',
};

// ─── Local Storage helpers ────────────────────────────────────────────────────
const store = {
  get: (key, fallback = null) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set: (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  notifications: [],
  aiLabels:      {},
  aiPriorities:  {},
  readState:     {},
  doneState:     {},
  githubUser:    null,
  activeFilter:  'all',
  filterPriority: '',
  filterRepo:    '',
  inboxType:     'all',
  loading:       false,
  page:          1,
  hasMore:       true,
};

// ─── GitHub API ───────────────────────────────────────────────────────────────
function ghToken() { return store.get(LS.GITHUB_TOKEN); }

async function ghFetch(path, opts = {}) {
  const token = ghToken();
  const res = await fetch(`${GH_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Notifly',
      Accept: 'application/vnd.github.v3+json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${path}`);
  return res.json();
}

async function fetchNotifications() {
  const res = await ghFetch('/notifications?all=false&per_page=100&participating=false&page=1');
  state.page = 1;
  state.hasMore = res.length === 100;
  return res;
}

async function loadMoreNotifications() {
  state.page++;
  try {
    const more = await ghFetch(`/notifications?all=false&per_page=100&participating=false&page=${state.page}`);
    state.notifications.push(...more);
    state.hasMore = more.length === 100;
    store.set(LS.NOTIFICATIONS, state.notifications);

    // Auto-label new notifications if Pollinations key exists
    if (skKey()) {
      const unlabeled = more.filter((n) => !state.aiLabels[n.id]);
      if (unlabeled.length > 0) {
        try {
          for (let i = 0; i < unlabeled.length; i += 20) {
            const batch = unlabeled.slice(i, i + 20);
            const [labels, priorities] = await Promise.all([
              aiLabelBatch(batch),
              aiPrioritizeBatch(batch),
            ]);
            Object.assign(state.aiLabels, labels);
            Object.assign(state.aiPriorities, priorities);
          }
          store.set(LS.AI_LABELS, state.aiLabels);
          store.set(LS.AI_PRIORITIES, state.aiPriorities);
          await syncLabelsToServer();
        } catch (err) {
          console.warn('Auto-labeling failed:', err.message);
        }
      }
    }

    return more;
  } catch (err) {
    state.page--;
    throw err;
  }
}

async function markRead(threadId) {
  const token = ghToken();
  await fetch(`${GH_API}/notifications/threads/${threadId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Notifly' },
  });
}

async function fetchGithubUser() {
  return ghFetch('/user');
}

// ─── Pollinations AI ──────────────────────────────────────────────────────────
function skKey() { return store.get(LS.POLLINATIONS_KEY); }

async function aiChat(messages) {
  const sk = skKey();
  if (!sk) throw new Error('No Pollinations key');
  const res = await fetch(POLLINATIONS_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, messages }),
  });
  if (!res.ok) throw new Error(`Pollinations ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

const VALID_LABELS = new Set(['mention', 'review-requested', 'ci-failure', 'noise', 'fyi']);

async function aiLabelBatch(notifications) {
  const items = notifications.map((n, i) =>
    `${i}: [${n.reason}] ${n.repository?.full_name}: ${n.subject?.title} (${n.subject?.type})`,
  ).join('\n');

  const raw = await aiChat([
    {
      role: 'system',
      content:
        'You are a GitHub notification classifier. For each numbered notification, respond with ONLY its index and one label separated by a colon, one per line. Labels: mention, review-requested, ci-failure, noise, fyi. Example:\n0: mention\n1: ci-failure',
    },
    { role: 'user', content: `Classify these notifications:\n${items}` },
  ]);

  const labels = {};
  for (const line of raw.split('\n')) {
    const [idx, label] = line.split(':').map((s) => s.trim());
    const i = parseInt(idx, 10);
    if (!isNaN(i) && VALID_LABELS.has(label) && notifications[i]) {
      labels[notifications[i].id] = label;
    }
  }
  return labels;
}

async function aiPrioritizeBatch(notifications) {
  const items = notifications.map((n, i) =>
    `${i}: [${n.reason}] ${n.repository?.full_name}: ${n.subject?.title}`,
  ).join('\n');

  const raw = await aiChat([
    {
      role: 'system',
      content:
        'You are a GitHub notification prioritizer. For each numbered notification respond with ONLY index:priority, one per line. Priority values: high, medium, low. Example:\n0: high\n1: low',
    },
    { role: 'user', content: `Prioritize:\n${items}` },
  ]);

  const priorities = {};
  for (const line of raw.split('\n')) {
    const [idx, pri] = line.split(':').map((s) => s.trim());
    const i = parseInt(idx, 10);
    if (!isNaN(i) && ['high','medium','low'].includes(pri) && notifications[i]) {
      priorities[notifications[i].id] = pri;
    }
  }
  return priorities;
}

async function aiOverview(notifications) {
  const summary = notifications.slice(0, 20).map(
    (n) => `[${n.reason}] ${n.repository?.full_name}: ${n.subject?.title}`,
  ).join('\n');
  return aiChat([
    {
      role: 'system',
      content: 'You are a helpful GitHub assistant. Write 2-3 sentences summarizing the user\'s current notification inbox state. Be specific — mention repos or PR names. Conversational tone.',
    },
    { role: 'user', content: `My current notifications:\n${summary}` },
  ]);
}

async function aiGenerateDigest(notifications) {
  const summary = notifications.slice(0, 30).map(
    (n) => `[${n.reason}] ${n.repository?.full_name}: ${n.subject?.title} (${n.subject?.type})`,
  ).join('\n');
  return aiChat([
    {
      role: 'system',
      content: 'Create a scannable GitHub notification digest. Use emoji section headers (🔴 Action Required, 🟡 FYI, ✅ Nothing Urgent). Highlight action items. Under 300 words.',
    },
    { role: 'user', content: `Digest these notifications:\n${summary}` },
  ]);
}

async function syncLabelsToServer() {
  try {
    await fetch('/api/user/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ai_labels: state.aiLabels,
        ai_priorities: state.aiPriorities,
      }),
    });
  } catch (err) {
    console.warn('Failed to sync labels to server:', err.message);
  }
}

async function loadLabelsFromServer() {
  try {
    const res = await fetch('/api/user/labels');
    if (!res.ok) return;
    const data = await res.json();
    state.aiLabels = data.ai_labels || {};
    state.aiPriorities = data.ai_priorities || {};
    store.set(LS.AI_LABELS, state.aiLabels);
    store.set(LS.AI_PRIORITIES, state.aiPriorities);
  } catch (err) {
    console.warn('Failed to load labels from server:', err.message);
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

// ─── Relative time ────────────────────────────────────────────────────────────
function relativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Type icon ────────────────────────────────────────────────────────────────
function typeIcon(type, reason) {
  if (reason === 'ci_activity' || type === 'CheckSuite') {
    return { cls: 'ci', html: '⚡' };
  }
  if (type === 'PullRequest') {
    return {
      cls: 'pr',
      html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>`,
    };
  }
  if (type === 'Issue') {
    return {
      cls: 'issue',
      html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    };
  }
  if (type === 'Release') {
    return { cls: 'release', html: '🚀' };
  }
  return { cls: 'other', html: '●' };
}

// ─── Render notification card ─────────────────────────────────────────────────
function renderNotifCard(notif, index) {
  const isRead  = !!state.readState[notif.id];
  const isDone  = !!state.doneState[notif.id];
  const label   = state.aiLabels[notif.id];
  const priority = state.aiPriorities[notif.id];
  const icon    = typeIcon(notif.subject?.type, notif.reason);

  const card = document.createElement('div');
  card.className = `notif-card${isRead ? '' : ' unread'}${isDone ? ' done' : ''}`;
  card.style.animationDelay = `${Math.min(index * 20, 200)}ms`;
  card.dataset.id = notif.id;
  card.setAttribute('role', 'listitem');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${notif.subject?.type}: ${notif.subject?.title}`);

  const labelBadge = label
    ? `<span class="label-badge label-${label}" aria-label="AI label: ${label}">${label}</span>`
    : '';
  const priorityDot = priority
    ? `<span class="priority-dot ${priority}" title="Priority: ${priority}" aria-label="Priority: ${priority}"></span>`
    : '';

  card.innerHTML = `
    <div class="notif-type-icon ${icon.cls}" aria-hidden="true">${icon.html}</div>
    <div class="notif-body">
      <div class="notif-repo mono">${notif.repository?.full_name || ''}</div>
      <div class="notif-title">${escHtml(notif.subject?.title || '')}</div>
      <div class="notif-meta">
        ${priorityDot}
        ${labelBadge}
        <span class="notif-time">${relativeTime(notif.updated_at)}</span>
        <span class="notif-time mono">${notif.reason?.replace(/_/g, ' ') || ''}</span>
      </div>
    </div>
    <div class="notif-actions">
      <button class="notif-action-btn btn-read" data-id="${notif.id}" title="${isRead ? 'Mark unread' : 'Mark read'}" aria-label="${isRead ? 'Mark unread' : 'Mark read'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          ${isRead
            ? '<circle cx="12" cy="12" r="10"/>'
            : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'}
        </svg>
      </button>
      <button class="notif-action-btn btn-done" data-id="${notif.id}" title="Mark done" aria-label="Mark done">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </button>
      <a class="notif-action-btn" href="${notif.subject?.url?.replace('api.github.com/repos', 'github.com').replace('/pulls/', '/pull/')}" target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </a>
    </div>
  `;

  // Click card → open detail panel
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    openDetailPanel(notif);
    if (!isRead) {
      state.readState[notif.id] = true;
      store.set(LS.READ_STATE, state.readState);
      card.classList.remove('unread');
      markRead(notif.id).catch(() => {});
      updateUnreadBadge();
    }
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') card.click();
  });

  return card;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function closeDetailPanel() {
  const panel = document.getElementById('detail-panel');
  const overlay = document.getElementById('detail-overlay');
  panel.classList.remove('open');
  panel.classList.add('hidden');
  overlay.classList.add('hidden');
}

async function openDetailPanel(notif) {
  const panel  = document.getElementById('detail-panel');
  const overlay = document.getElementById('detail-overlay');

  // Show panel immediately with base info
  panel.classList.remove('hidden');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => panel.classList.add('open'));
  panel.focus();

  const icon = typeIcon(notif.subject?.type, notif.reason);
  const label = state.aiLabels[notif.id];
  const priority = state.aiPriorities[notif.id];
  const ghUrl = notif.subject?.url
    ?.replace('api.github.com/repos', 'github.com')
    .replace('/pulls/', '/pull/');

  document.getElementById('detail-repo').textContent = notif.repository?.full_name || '';
  document.getElementById('detail-title').textContent = notif.subject?.title || '';
  document.getElementById('detail-type-icon').className = `detail-type-icon ${icon.cls}`;
  document.getElementById('detail-type-icon').innerHTML = icon.html;
  document.getElementById('detail-btn-github').href = ghUrl || '#';

  // Badges
  const badgesEl = document.getElementById('detail-badges');
  badgesEl.innerHTML = '';
  if (label) {
    const lb = document.createElement('span');
    lb.className = `label-badge label-${label}`;
    lb.textContent = label;
    badgesEl.appendChild(lb);
  }
  if (priority) {
    const pb = document.createElement('span');
    pb.className = `label-badge label-${priority === 'high' ? 'ci-failure' : priority === 'medium' ? 'review-requested' : 'fyi'}`;
    pb.textContent = `${priority} priority`;
    badgesEl.appendChild(pb);
  }

  // Meta grid (initial)
  const metaEl = document.getElementById('detail-meta-grid');
  const reason = notif.reason?.replace(/_/g, ' ') || '—';
  metaEl.innerHTML = `
    <div class="detail-meta-item">
      <span class="detail-meta-label">Type</span>
      <span class="detail-meta-value">${notif.subject?.type || '—'}</span>
    </div>
    <div class="detail-meta-item">
      <span class="detail-meta-label">Reason</span>
      <span class="detail-meta-value">${reason}</span>
    </div>
    <div class="detail-meta-item">
      <span class="detail-meta-label">Updated</span>
      <span class="detail-meta-value">${relativeTime(notif.updated_at)}</span>
    </div>
    <div class="detail-meta-item">
      <span class="detail-meta-label">Repo</span>
      <span class="detail-meta-value mono" style="font-size:0.72rem">${notif.repository?.full_name || '—'}</span>
    </div>
  `;

  // Action buttons wired for this notif
  const readBtn = document.getElementById('detail-btn-read');
  const doneBtn = document.getElementById('detail-btn-done');
  readBtn.textContent = state.readState[notif.id] ? 'Mark unread' : 'Mark read';
  readBtn.onclick = () => {
    state.readState[notif.id] = !state.readState[notif.id];
    store.set(LS.READ_STATE, state.readState);
    readBtn.textContent = state.readState[notif.id] ? 'Mark unread' : 'Mark read';
    if (state.readState[notif.id]) markRead(notif.id).catch(() => {});
    updateUnreadBadge();
    renderInbox();
  };
  doneBtn.onclick = () => {
    state.doneState[notif.id] = true;
    store.set(LS.DONE_STATE, state.doneState);
    closeDetailPanel();
    renderInbox();
    toast('Marked done', 'success');
  };

  // AI summary
  const aiEl = document.getElementById('detail-ai-text');
  const aiSection = document.getElementById('detail-ai-section');
  if (skKey()) {
    aiEl.textContent = 'Generating summary…';
    aiEl.classList.add('loading');
    aiSection.classList.remove('hidden');
    aiChat([
      {
        role: 'system',
        content: 'You are a concise GitHub assistant. In 2-4 sentences, explain what this notification is about, why it matters, and what (if any) action the user should take. Be specific and direct.',
      },
      {
        role: 'user',
        content: `Notification: [${notif.reason}] ${notif.repository?.full_name}: ${notif.subject?.title} (${notif.subject?.type})`,
      },
    ]).then((text) => {
      aiEl.textContent = text;
      aiEl.classList.remove('loading');
    }).catch(() => {
      aiEl.textContent = 'Could not generate summary.';
      aiEl.classList.remove('loading');
    });
  } else {
    aiSection.classList.add('hidden');
  }

  // Fetch thread details from GitHub
  const threadSection = document.getElementById('detail-thread-section');
  const threadBody = document.getElementById('detail-thread-body');
  threadSection.classList.add('hidden');
  threadBody.innerHTML = '';

  try {
    const subjectUrl = notif.subject?.url;
    if (!subjectUrl) return;

    // subject.url is already a GitHub API URL like https://api.github.com/repos/owner/repo/pulls/123
    const path = subjectUrl.replace('https://api.github.com', '');
    const detail = await ghFetch(path);

    // Status badge
    const statusBadge = document.createElement('span');
    const st = detail.merged ? 'merged' : detail.draft ? 'draft' : detail.state || '';
    if (st) {
      statusBadge.className = `detail-status-badge ${st}`;
      statusBadge.innerHTML = `<span>●</span> ${st}`;
      badgesEl.insertBefore(statusBadge, badgesEl.firstChild);
    }

    // Enrich meta
    const author = detail.user?.login || '—';
    metaEl.innerHTML += `
      <div class="detail-meta-item">
        <span class="detail-meta-label">Author</span>
        <span class="detail-meta-value mono">${escHtml(author)}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Created</span>
        <span class="detail-meta-value">${relativeTime(detail.created_at)}</span>
      </div>
    `;
    if (detail.comments !== undefined) {
      metaEl.innerHTML += `<div class="detail-meta-item"><span class="detail-meta-label">Comments</span><span class="detail-meta-value">${detail.comments}</span></div>`;
    }
    if (detail.commits !== undefined) {
      metaEl.innerHTML += `<div class="detail-meta-item"><span class="detail-meta-label">Commits</span><span class="detail-meta-value">${detail.commits}</span></div>`;
    }

    // Fetch last 3 comments
    if (detail.comments > 0 && detail.comments_url) {
      const commentsPath = detail.comments_url.replace('https://api.github.com', '');
      const comments = await ghFetch(`${commentsPath}?per_page=3&sort=updated&direction=desc`);
      if (comments?.length > 0) {
        threadSection.classList.remove('hidden');
        comments.slice(0, 3).forEach((c) => {
          const el = document.createElement('div');
          el.className = 'detail-comment';
          el.innerHTML = `
            <div class="detail-comment-header">
              <img class="detail-comment-avatar" src="${escHtml(c.user?.avatar_url || '')}" alt="${escHtml(c.user?.login || '')}" loading="lazy" />
              <span class="detail-comment-author">${escHtml(c.user?.login || '—')}</span>
              <span class="detail-comment-time">${relativeTime(c.updated_at || c.created_at)}</span>
            </div>
            <div class="detail-comment-body">${escHtml(c.body?.trim() || '')}</div>
          `;
          threadBody.appendChild(el);
        });
      }
    }
  } catch {
    // Thread fetch failed silently — panel still shows base info
  }
}

function initDetailPanel() {
  document.getElementById('detail-close').addEventListener('click', closeDetailPanel);
  document.getElementById('detail-overlay').addEventListener('click', closeDetailPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetailPanel();
  });
}

// ─── Apply filters ────────────────────────────────────────────────────────────
function applyFilters(notifications) {
  return notifications.filter((n) => {
    if (state.doneState[n.id]) return false;

    // Inbox type filter (from route)
    if (state.inboxType === 'mention' && state.aiLabels[n.id] !== 'mention') return false;
    if (state.inboxType === 'review-requested' && state.aiLabels[n.id] !== 'review-requested') return false;
    if (state.inboxType === 'ci-failure' && state.aiLabels[n.id] !== 'ci-failure') return false;
    if (state.inboxType === 'unread' && state.readState[n.id]) return false;

    // Filter bar filters
    const filter = state.activeFilter;
    if (filter === 'unread'  && state.readState[n.id]) return false;
    if (filter === 'mention' && state.aiLabels[n.id] !== 'mention') return false;
    if (filter === 'review-requested' && state.aiLabels[n.id] !== 'review-requested') return false;
    if (filter === 'ci-failure' && state.aiLabels[n.id] !== 'ci-failure') return false;

    if (state.filterPriority && state.aiPriorities[n.id] !== state.filterPriority) return false;
    if (state.filterRepo     && n.repository?.full_name !== state.filterRepo) return false;

    return true;
  });
}

// ─── Render inbox ─────────────────────────────────────────────────────────────
function renderInbox() {
  const list    = document.getElementById('notification-list');
  const skeleton = document.getElementById('notif-skeleton');
  const empty   = document.getElementById('inbox-empty');
  skeleton?.remove();

  // Remove existing cards (but not skeleton/empty)
  list.querySelectorAll('.notif-card').forEach((el) => el.remove());

  const visible = applyFilters(state.notifications);
  empty.classList.toggle('hidden', visible.length > 0);

  visible.forEach((n, i) => {
    list.appendChild(renderNotifCard(n, i));
  });

  // Show/hide load more button
  const loadMoreArea = document.getElementById('load-more-area');
  loadMoreArea.classList.toggle('hidden', !state.hasMore || visible.length === 0);

  updateRepoFilter();
}

function updateRepoFilter() {
  const sel = document.getElementById('filter-repo');
  if (!sel) return;
  const repos = [...new Set(state.notifications.map((n) => n.repository?.full_name).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">All repos</option>';
  repos.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function updateUnreadBadge() {
  const badge = document.getElementById('unread-badge');
  const count = state.notifications.filter(
    (n) => !state.readState[n.id] && !state.doneState[n.id],
  ).length;
  badge.textContent = count > 0 ? String(count) : '';
}

// ─── Render dashboard ─────────────────────────────────────────────────────────
function renderDashboard() {
  const notifs = state.notifications.filter((n) => !state.doneState[n.id]);

  // Stats
  document.getElementById('stat-unread').textContent =
    notifs.filter((n) => !state.readState[n.id]).length;
  document.getElementById('stat-prs').textContent =
    notifs.filter((n) => n.subject?.type === 'PullRequest').length;
  document.getElementById('stat-issues').textContent =
    notifs.filter((n) => n.subject?.type === 'Issue').length;
  document.getElementById('stat-ci').textContent =
    notifs.filter((n) => state.aiLabels[n.id] === 'ci-failure').length;

  // Priority queue (top 5 high/medium)
  const pqList = document.getElementById('priority-queue-list');
  pqList.innerHTML = '';
  const prioritized = notifs
    .filter((n) => state.aiPriorities[n.id])
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[state.aiPriorities[a.id]] ?? 3) - (order[state.aiPriorities[b.id]] ?? 3);
    })
    .slice(0, 5);

  if (prioritized.length === 0) {
    pqList.innerHTML = '<div class="empty-state" style="padding:1.5rem"><p>No prioritized items yet. Run AI Label All from the inbox.</p></div>';
  } else {
    prioritized.forEach((n) => {
      const item = document.createElement('a');
      item.className = 'priority-item';
      item.href = n.subject?.url?.replace('api.github.com/repos', 'github.com').replace('/pulls/', '/pull/') || '#';
      item.target = '_blank';
      item.rel = 'noopener noreferrer';
      item.innerHTML = `
        <span class="priority-dot ${state.aiPriorities[n.id]}"></span>
        <div class="priority-item-body">
          <div class="priority-item-repo mono">${n.repository?.full_name || ''}</div>
          <div class="priority-item-title">${escHtml(n.subject?.title || '')}</div>
        </div>
      `;
      pqList.appendChild(item);
    });
  }

  // Repo activity
  const repoActivityList = document.getElementById('repo-activity-list');
  repoActivityList.innerHTML = '';
  const repoCounts = {};
  notifs.forEach((n) => {
    const repo = n.repository?.full_name;
    if (repo) repoCounts[repo] = (repoCounts[repo] || 0) + 1;
  });
  const topRepos = Object.entries(repoCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCount = topRepos[0]?.[1] || 1;
  topRepos.forEach(([repo, count]) => {
    const row = document.createElement('div');
    row.className = 'repo-row';
    row.innerHTML = `
      <span class="repo-name">${repo}</span>
      <div class="repo-bar-wrap"><div class="repo-bar" style="width:${(count/maxCount)*100}%"></div></div>
      <span class="repo-count mono">${count}</span>
    `;
    repoActivityList.appendChild(row);
  });

  // AI overview
  const sk = skKey();
  const overviewEl = document.getElementById('ai-overview-text');
  if (sk && notifs.length > 0) {
    aiOverview(notifs)
      .then((text) => { overviewEl.textContent = text; })
      .catch(() => { overviewEl.textContent = 'AI overview unavailable.'; });
  } else if (!sk) {
    overviewEl.textContent = 'Connect your Pollinations account in Settings to enable AI overview.';
  } else {
    overviewEl.textContent = 'No unread notifications right now. ✨';
  }
}

// ─── Render digest ────────────────────────────────────────────────────────────
function renderDigest() {
  const digestData = store.get(LS.LATEST_DIGEST);
  const card  = document.getElementById('digest-card');
  const empty = document.getElementById('digest-empty');

  if (!digestData) {
    card.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  card.classList.remove('hidden');
  empty.classList.add('hidden');

  document.getElementById('digest-timestamp').textContent =
    `Generated ${relativeTime(digestData.generated_at)}`;
  const countBadge = document.getElementById('digest-notif-count');
  countBadge.textContent = `${digestData.notification_count} notifications`;
  countBadge.className = 'badge badge-accent';
  document.getElementById('digest-body').textContent = digestData.content;
}

// ─── Render settings ──────────────────────────────────────────────────────────
async function renderSettings() {
  const sk = skKey();
  const keyStatusEl = document.getElementById('pollinations-key-status');
  if (sk) {
    keyStatusEl.textContent = `✓ Connected (${sk.slice(0, 8)}…)`;
    keyStatusEl.className = 'key-status connected';
  } else {
    keyStatusEl.textContent = '✗ Not connected';
    keyStatusEl.className = 'key-status disconnected';
  }

  const user = state.githubUser;
  if (user) {
    const infoEl = document.getElementById('settings-user-info');
    infoEl.innerHTML = `
      <img src="${user.avatar_url}" alt="${user.login}" class="avatar avatar-md" />
      <div>
        <div style="font-weight:600">${escHtml(user.name || user.login)}</div>
        <div class="mono" style="font-size:0.8rem;color:var(--text-tertiary)">@${escHtml(user.login)}</div>
      </div>
    `;
  }

  // Push notification status
  const pushArea = document.getElementById('push-status-area');
  const pushToggle = document.getElementById('push-notif-enabled');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pushArea.innerHTML = '<p class="form-status error" style="margin:0">Push notifications are not supported in this browser.</p>';
    pushToggle.disabled = true;
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      pushArea.innerHTML = '<p class="form-status success" style="margin:0">✓ This device is registered for push</p>';
      document.getElementById('btn-register-push').textContent = 'Re-register device';
    } else {
      pushArea.innerHTML = '<p class="form-status" style="margin:0;color:var(--text-tertiary)">This device is not registered. Click below to enable push.</p>';
    }
  } catch {
    pushArea.innerHTML = '';
  }

  // Load saved preference from server
  fetch('/api/user/me').then((r) => r.ok ? r.json() : null).then((data) => {
    if (data?.push_notif_enabled) pushToggle.checked = true;
  }).catch(() => {});
}

// ─── Router ───────────────────────────────────────────────────────────────────
const ROUTES = ['inbox', 'dashboard', 'digest', 'settings'];

function navigate(route, inboxType = null) {
  const baseRoute = route.split('/')[0];
  if (!ROUTES.includes(baseRoute)) route = baseRoute = 'inbox';

  if (inboxType) state.inboxType = inboxType;

  // Update sidebar active state
  document.querySelectorAll('.sidebar-link, .sidebar-sublink').forEach((link) => {
    const isActive = link.dataset.route === baseRoute && (!inboxType || link.dataset.type === inboxType);
    link.classList.toggle('active', isActive);
  });

  // Show/hide views
  ROUTES.forEach((r) => {
    document.getElementById(`view-${r}`)?.classList.toggle('hidden', r !== baseRoute);
  });

  // Trigger route-specific render
  if (baseRoute === 'inbox')     renderInbox();
  if (baseRoute === 'dashboard') renderDashboard();
  if (baseRoute === 'digest')    renderDigest();
  if (baseRoute === 'settings')  renderSettings();
}

function initRouter() {
  const getRoute = () => {
    const hash = location.hash.replace(/^#\/?/, '');
    const [route, query] = hash.split('?');
    const [baseRoute, inboxType] = route.split('/');
    if (!ROUTES.includes(baseRoute)) return { base: 'inbox', type: null };
    return { base: baseRoute, type: inboxType || null };
  };
  window.addEventListener('hashchange', () => {
    const { base, type } = getRoute();
    navigate(base, type);
  });
  const { base, type } = getRoute();
  navigate(base, type);
}

// ─── Auth flow ────────────────────────────────────────────────────────────────
function handleAuthFragment() {
  const hash = location.hash;
  if (!hash) return false;

  const params = new URLSearchParams(hash.slice(1));
  const token  = params.get('auth_token');
  const uid    = params.get('uid');
  const sk     = params.get('api_key'); // Pollinations BYOP redirect

  if (token && uid) {
    store.set(LS.GITHUB_TOKEN, token);
    // Clean fragment
    history.replaceState(null, '', location.pathname);
    return 'github_authed';
  }

  if (sk) {
    store.set(LS.POLLINATIONS_KEY, sk);
    // Sync to KV for cron
    fetch('/api/user/save-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollinations_key: sk }),
    }).catch(() => {});
    history.replaceState(null, '', location.pathname);
    return 'pollinations_authed';
  }

  return false;
}

function showScreen(id) {
  ['screen-auth', 'screen-byop', 'app'].forEach((s) => {
    document.getElementById(s)?.classList.add('hidden');
  });
  document.getElementById(id)?.classList.remove('hidden');
}

function launchPollinationsAuth(appKey) {
  const redirectUri = encodeURIComponent(location.origin);
  window.location.href = `https://enter.pollinations.ai/authorize?redirect_uri=${redirectUri}&client_id=${appKey}`;
}

// ─── Load notifications ───────────────────────────────────────────────────────
async function loadNotifications(force = false) {
  // Use cached if fresh enough (5 min)
  const cached = store.get(LS.NOTIFICATIONS);
  const lastFetch = store.get('notifly:last_fetch', 0);
  if (!force && cached && Date.now() - lastFetch < 5 * 60 * 1000) {
    state.notifications = cached;
    return;
  }

  try {
    const notifs = await fetchNotifications();
    state.notifications = notifs;
    store.set(LS.NOTIFICATIONS, notifs);
    store.set('notifly:last_fetch', Date.now());
  } catch (err) {
    // Fall back to cache
    if (cached) state.notifications = cached;
    toast('Failed to fetch notifications — showing cached data', 'error');
  }
}

// ─── Push notifications ───────────────────────────────────────────────────────
async function registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const vapidKey = await fetch('/manifest.json').then((r) => r.json()).then((m) => m.vapid_public_key).catch(() => null);
  if (!vapidKey) return;

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });
  await fetch('/api/user/save-prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ push_sub: sub.toJSON() }),
  });
  toast('Web Push notifications enabled!', 'success');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ─── Event handlers ───────────────────────────────────────────────────────────
function bindInboxEvents() {
  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.activeFilter = chip.dataset.filter;
      renderInbox();
    });
  });

  document.getElementById('filter-priority')?.addEventListener('change', (e) => {
    state.filterPriority = e.target.value;
    renderInbox();
  });

  document.getElementById('filter-repo')?.addEventListener('change', (e) => {
    state.filterRepo = e.target.value;
    renderInbox();
  });

  // Mark all read
  document.getElementById('btn-mark-all-read')?.addEventListener('click', async () => {
    const unread = state.notifications.filter((n) => !state.readState[n.id]);
    unread.forEach((n) => { state.readState[n.id] = true; });
    store.set(LS.READ_STATE, state.readState);
    await Promise.allSettled(unread.map((n) => markRead(n.id)));
    updateUnreadBadge();
    renderInbox();
    toast(`Marked ${unread.length} notifications as read`, 'success');
  });

  // AI label all
  document.getElementById('btn-ai-label-all')?.addEventListener('click', async () => {
    if (!skKey()) { toast('Connect Pollinations in Settings to use AI features', 'error'); return; }
    const btn = document.getElementById('btn-ai-label-all');
    btn.disabled = true;
    btn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Labeling…';
    try {
      const unlabeled = state.notifications.filter((n) => !state.aiLabels[n.id]);
      if (unlabeled.length === 0) { toast('All notifications already labeled', 'info'); return; }

      // Process in batches of 20
      for (let i = 0; i < unlabeled.length; i += 20) {
        const batch = unlabeled.slice(i, i + 20);
        const [labels, priorities] = await Promise.all([
          aiLabelBatch(batch),
          aiPrioritizeBatch(batch),
        ]);
        Object.assign(state.aiLabels, labels);
        Object.assign(state.aiPriorities, priorities);
      }

      store.set(LS.AI_LABELS, state.aiLabels);
      store.set(LS.AI_PRIORITIES, state.aiPriorities);
      await syncLabelsToServer();
      renderInbox();
      toast('AI labels applied!', 'success');
    } catch (err) {
      toast(`AI labeling failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> AI Label All';
    }
  });

  // Load more
  document.getElementById('btn-load-more')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-load-more');
    btn.disabled = true;
    btn.innerHTML = 'Loading…';
    try {
      await loadMoreNotifications();
      renderInbox();
      toast(`Loaded more notifications`, 'success');
    } catch (err) {
      toast(`Failed to load more: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Load More';
    }
  });

  // Read/done actions (delegated)
  document.getElementById('notification-list')?.addEventListener('click', async (e) => {
    const readBtn = e.target.closest('.btn-read');
    const doneBtn = e.target.closest('.btn-done');

    if (readBtn) {
      e.stopPropagation();
      const id = readBtn.dataset.id;
      state.readState[id] = !state.readState[id];
      store.set(LS.READ_STATE, state.readState);
      if (state.readState[id]) markRead(id).catch(() => {});
      updateUnreadBadge();
      renderInbox();
    }

    if (doneBtn) {
      e.stopPropagation();
      const id = doneBtn.dataset.id;
      state.doneState[id] = true;
      store.set(LS.DONE_STATE, state.doneState);
      state.readState[id] = true;
      store.set(LS.READ_STATE, state.readState);
      markRead(id).catch(() => {});
      updateUnreadBadge();
      renderInbox();
    }
  });
}

function bindDashboardEvents() {
  document.getElementById('btn-refresh-overview')?.addEventListener('click', () => {
    const overviewEl = document.getElementById('ai-overview-text');
    if (!skKey()) { toast('No Pollinations key', 'error'); return; }
    overviewEl.textContent = 'Generating…';
    aiOverview(state.notifications)
      .then((text) => { overviewEl.textContent = text; })
      .catch(() => { overviewEl.textContent = 'AI overview unavailable.'; });
  });
}

function bindDigestEvents() {
  document.getElementById('btn-gen-digest')?.addEventListener('click', async () => {
    if (!skKey()) { toast('Connect Pollinations in Settings to generate digest', 'error'); return; }
    const btn = document.getElementById('btn-gen-digest');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const content = await aiGenerateDigest(state.notifications);
      const digestData = {
        content,
        generated_at: new Date().toISOString(),
        notification_count: state.notifications.length,
      };
      store.set(LS.LATEST_DIGEST, digestData);
      renderDigest();
      toast('Digest generated!', 'success');
    } catch (err) {
      toast(`Digest generation failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate Fresh Digest';
    }
  });
}

function bindSettingsEvents() {
  document.getElementById('btn-save-prefs')?.addEventListener('click', async () => {
    const discord  = document.getElementById('setting-discord')?.value?.trim();
    const morning  = document.getElementById('sched-morning')?.checked;
    const nightly  = document.getElementById('sched-nightly')?.checked;
    const weekly   = document.getElementById('sched-weekly')?.checked;
    const pushDel  = document.getElementById('delivery-push')?.checked;

    const schedule = [morning && 'morning', nightly && 'nightly', weekly && 'weekly'].filter(Boolean);
    const statusEl = document.getElementById('save-prefs-status');

    try {
      await fetch('/api/user/save-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discord_webhook: discord || undefined,
          digest_schedule: schedule,
        }),
      });

      if (pushDel) await registerPush();

      statusEl.textContent = 'Preferences saved!';
      statusEl.className = 'form-status success';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'form-status'; }, 3000);
      toast('Settings saved', 'success');
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'form-status error';
    }
  });

  // Per-notification push toggle
  document.getElementById('push-notif-enabled')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    const statusEl = document.getElementById('push-notif-status');
    try {
      if (enabled) {
        // Must have push subscription first
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          await registerPush();
          sub = await reg.pushManager.getSubscription();
        }
        if (!sub) {
          e.target.checked = false;
          toast('Push registration failed — please register the device first', 'error');
          return;
        }
      }
      await fetch('/api/user/save-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push_notif_enabled: enabled }),
      });
      statusEl.textContent = enabled ? 'Per-notification push enabled' : 'Per-notification push disabled';
      statusEl.className = 'form-status success';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'form-status'; }, 3000);
      toast(enabled ? 'Push notifications enabled' : 'Push notifications disabled', 'success');
    } catch (err) {
      e.target.checked = !enabled;
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'form-status error';
    }
  });

  document.getElementById('btn-register-push')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-register-push');
    const statusEl = document.getElementById('push-notif-status');
    btn.disabled = true;
    try {
      await registerPush();
      statusEl.textContent = '✓ Device registered for push';
      statusEl.className = 'form-status success';
      document.getElementById('push-status-area').innerHTML =
        '<p class="form-status success" style="margin:0">✓ This device is registered for push</p>';
      btn.textContent = 'Re-register device';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'form-status'; }, 3000);
    } catch (err) {
      statusEl.textContent = `Registration failed: ${err.message}`;
      statusEl.className = 'form-status error';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-reauth-pollinations')?.addEventListener('click', async () => {
    // Fetch app key from manifest
    const manifest = await fetch('/manifest.json').then((r) => r.json()).catch(() => ({}));
    const appKey = manifest.pollinations_app_key;
    if (!appKey) { toast('POLLINATIONS_APP_KEY not configured', 'error'); return; }
    launchPollinationsAuth(appKey);
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    if (!confirm('Sign out of Notifly?')) return;
    Object.values(LS).forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem('notifly:last_fetch');
    window.location.reload();
  });
}

function bindGlobalEvents() {
  // Inbox submenu toggle
  document.getElementById('inbox-expand')?.addEventListener('click', (e) => {
    e.preventDefault();
    const submenu = e.currentTarget.closest('.sidebar-group').querySelector('.sidebar-submenu');
    submenu.classList.toggle('hidden');
    e.currentTarget.setAttribute('aria-expanded', !submenu.classList.contains('hidden'));
  });

  // Inbox sublinks
  document.querySelectorAll('.sidebar-sublink').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const type = link.dataset.type;
      navigate('inbox', type === 'all' ? null : type);
      window.location.hash = type === 'all' ? '#/inbox/all' : `#/inbox/${type}`;
      if (window.innerWidth <= 640) {
        document.getElementById('sidebar').classList.remove('mobile-open');
      }
    });
  });

  // Sidebar toggle
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    const expanded = !sidebar.classList.contains('collapsed');
    document.getElementById('sidebar-toggle').setAttribute('aria-expanded', String(expanded));
  });

  // Mobile sidebar
  const mobileBtn = document.createElement('button');
  mobileBtn.className = 'mobile-menu-btn';
  mobileBtn.setAttribute('aria-label', 'Open navigation');
  mobileBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(mobileBtn);
  document.body.appendChild(overlay);

  const sidebar = document.getElementById('sidebar');
  mobileBtn.addEventListener('click', () => {
    sidebar.classList.toggle('mobile-open');
    overlay.style.display = sidebar.classList.contains('mobile-open') ? 'block' : 'none';
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('mobile-open');
    overlay.style.display = 'none';
  });

  // Refresh button
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.querySelector('svg').classList.add('spin');
    await loadNotifications(true);
    btn.querySelector('svg').classList.remove('spin');
    updateUnreadBadge();
    renderInbox();
    toast('Notifications refreshed', 'success');
  });

  // Auth screen buttons
  document.getElementById('btn-github-login')?.addEventListener('click', () => {
    window.location.href = '/api/auth/login';
  });

  document.getElementById('btn-pollinations-auth')?.addEventListener('click', async () => {
    const manifest = await fetch('/manifest.json').then((r) => r.json()).catch(() => ({}));
    const appKey = manifest.pollinations_app_key;
    if (appKey) {
      launchPollinationsAuth(appKey);
    } else {
      toast('POLLINATIONS_APP_KEY not set — AI features will be unavailable', 'error');
      showApp();
    }
  });

  document.getElementById('btn-skip-byop')?.addEventListener('click', showApp);

  // Sidebar nav links (close mobile sidebar after nav)
  document.querySelectorAll('.sidebar-link').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 640) {
        sidebar.classList.remove('mobile-open');
        overlay.style.display = 'none';
      }
    });
  });
}

// ─── Show main app ────────────────────────────────────────────────────────────
async function showApp() {
  showScreen('app');
  initRouter();
  initDetailPanel();
  bindInboxEvents();
  bindDashboardEvents();
  bindDigestEvents();
  bindSettingsEvents();

  await loadNotifications();
  await loadLabelsFromServer();
  updateUnreadBadge();
  renderInbox();

  // Background check for latest digest from server
  fetch('/api/user/me')
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (data?.latest_digest) {
        try {
          const digest = JSON.parse(data.latest_digest);
          const localDigest = store.get(LS.LATEST_DIGEST);
          if (!localDigest || new Date(digest.generated_at) > new Date(localDigest.generated_at)) {
            store.set(LS.LATEST_DIGEST, digest);
          }
        } catch { /* ignore */ }
      }
    })
    .catch(() => {});
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  // Load persisted state
  state.aiLabels    = store.get(LS.AI_LABELS, {});
  state.aiPriorities = store.get(LS.AI_PRIORITIES, {});
  state.readState   = store.get(LS.READ_STATE, {});
  state.doneState   = store.get(LS.DONE_STATE, {});
  state.githubUser  = store.get(LS.GITHUB_USER);

  bindGlobalEvents();

  // Handle OAuth / BYOP redirect fragments
  const authResult = handleAuthFragment();

  const token = ghToken();

  if (!token) {
    showScreen('screen-auth');
    return;
  }

  // Fetch/cache GitHub user profile
  if (!state.githubUser) {
    fetchGithubUser().then((user) => {
      state.githubUser = user;
      store.set(LS.GITHUB_USER, user);
      const avatarEl = document.getElementById('user-avatar');
      const loginEl  = document.getElementById('user-login');
      if (avatarEl) { avatarEl.src = user.avatar_url; avatarEl.alt = user.login; }
      if (loginEl)  loginEl.textContent = user.login;
    }).catch(() => {});
  } else {
    const avatarEl = document.getElementById('user-avatar');
    const loginEl  = document.getElementById('user-login');
    if (avatarEl) { avatarEl.src = state.githubUser.avatar_url; avatarEl.alt = state.githubUser.login; }
    if (loginEl)  loginEl.textContent = state.githubUser.login;
  }

  // After GitHub auth: show BYOP if no sk_ yet
  if (authResult === 'github_authed' && !skKey()) {
    const manifest = await fetch('/manifest.json').then((r) => r.json()).catch(() => ({}));
    if (manifest.pollinations_app_key) {
      showScreen('screen-byop');
      return;
    }
  }

  await showApp();
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
