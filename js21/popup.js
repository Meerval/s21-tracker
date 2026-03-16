// ── Constants ─────────────────────────────────────────────────────
const BASE_URL  = 'https://platform.21-school.ru/services/21-school/api';
const AUTH_URL  = 'https://auth.21-school.ru/auth/realms/EduPowerKeycloak/protocol/openid-connect/token';
const MAIN_CAMPUSES = new Set(['21 Moscow','21 Kazan','21 Novosibirsk']);
const BATCH = 10;

// ── State ─────────────────────────────────────────────────────────
let accessToken = '';
let _cachedCreds = null;
let campusList = [];
let currentCampusGroup = 'all';
let currentProjectId = '';
let allStudents = [];
let filteredList = [];
let savedLogins = new Set();
let sortCol = null, sortDir = 'asc';
const _projectTitleCache = {};

// ── Storage ───────────────────────────────────────────────────────
const store = {
  get(key) {
    return new Promise(resolve =>
      chrome.storage.local.get(key, r => resolve(r[key] ?? null))
    );
  },
  set(key, value) {
    return new Promise(resolve =>
      chrome.storage.local.set({ [key]: value }, resolve)
    );
  },
  remove(key) {
    return new Promise(resolve =>
      chrome.storage.local.remove(key, resolve)
    );
  },
  keys(prefix) {
    return new Promise(resolve =>
      chrome.storage.local.get(null, items =>
        resolve(Object.keys(items).filter(k => k.startsWith(prefix)))
      )
    );
  },
};

// ── API ───────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(url, opts = {}) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status === 429) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 30000));
        continue;
      }
      return resp;
    } catch(e) {
      if (attempt < 19) await sleep(Math.min(500 * Math.pow(2, attempt), 15000));
    }
  }
  return null;
}

async function safeJson(resp) {
  try {
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await resp.json();
  } catch(e) {}
  return null;
}

async function apiGet(path) {
  const resp = await apiFetch(BASE_URL + path, {
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });
  if (!resp) return { status: 0, data: null };
  if (resp.status === 401) {
    try {
      await auth(_cachedCreds);
      const resp2 = await apiFetch(BASE_URL + path, {
        headers: { 'Authorization': 'Bearer ' + accessToken }
      });
      if (!resp2) return { status: 0, data: null };
      return { status: resp2.status, data: await safeJson(resp2) };
    } catch(e) {
      return { status: 401, data: null };
    }
  }
  return { status: resp.status, data: await safeJson(resp) };
}

// ── Auth ──────────────────────────────────────────────────────────
async function auth(creds) {
  const username = creds?.username || document.getElementById('username').value.trim();
  const password = creds?.password || document.getElementById('password').value.trim();
  if (!username || !password) throw new Error('Укажи логин и пароль');
  const resp = await apiFetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 's21-open-api', username, password })
  });
  if (!resp) throw new Error('Нет ответа от сервера');
  const data = await resp.json();
  if (!data?.access_token) throw new Error(data?.error_description || 'Ошибка авторизации');
  accessToken = data.access_token;
  _cachedCreds = { username, password };
  await store.set('credentials', { username, password });
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  const onQ = (sel, ev, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(ev, fn); };

  on('loginBtn', 'click', doLogin);
  ['username','password'].forEach(id => on(id, 'keydown', e => { if (e.key === 'Enter') doLogin(); }));
  on('projectId', 'input',  onProjectIdInput);
  on('projectId', 'focus',  showProjectDropdown);
  on('projectId', 'blur',   () => setTimeout(hideProjectDropdown, 150));
  ['all','main','other','custom'].forEach(g => on('cg-' + g, 'click', () => selectCampusGroup(g)));
  document.querySelectorAll('[data-status]').forEach(el =>
    el.addEventListener('click', () => el.classList.toggle('checked'))
  );
  on('backToOverviewBtn', 'click', backToOverview);
  on('searchBtn',    'click', runSearch);
  on('saveBtn',      'click', saveList);
  on('csvBtn',       'click', exportCsv);
  on('htmlBtn',      'click', exportHtml);
  on('clearBtn',     'click', clearSaved);
  on('searchFilter', 'input', filterTable);
  on('logoutBtn',    'click', logout);
  onQ('.detail-close', 'click', closeDetail);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });

  initApp();
});

async function initApp() {
  const creds = await store.get('credentials');
  if (creds?.username && creds?.password) {
    _cachedCreds = creds;
    document.getElementById('username').value = creds.username;
    document.getElementById('password').value = creds.password;
    try {
      await auth(creds);
      showAuthorized(creds.username);
      await loadCampuses();
    } catch(e) { /* show login form */ }
  }
}

async function doLogin() {
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '...';
  try {
    await auth(null);
    showAuthorized(_cachedCreds.username);
    await loadCampuses();
  } catch(e) {
    showToast('error', e.message);
    btn.disabled = false; btn.textContent = '→ ВОЙТИ';
  }
}

function showAuthorized(username) {
  document.getElementById('authForm').style.display = 'none';
  document.getElementById('gated').style.display = 'flex';
  document.getElementById('searchWrap').style.display = 'block';
  document.getElementById('authStatus').style.display = 'flex';
  document.getElementById('authStatusText').textContent = username || '';
}

async function logout() {
  accessToken = ''; _cachedCreds = null; campusList = [];
  currentCampusGroup = 'all'; allStudents = []; savedLogins = new Set();
  // Keep credentials for next login — only clear token
  document.getElementById('authForm').style.display = '';
  document.getElementById('gated').style.display = 'none';
  document.getElementById('searchWrap').style.display = 'none';
  document.getElementById('authStatus').style.display = 'none';
  document.getElementById('authStatusText').textContent = '';
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
  showState('info', 'Войди чтобы продолжить');
}

// ── Campuses ──────────────────────────────────────────────────────
async function loadCampuses() {
  try {
    const r = await apiGet('/v1/campuses');
    if (r.status !== 200 || !r.data) return;
    campusList = (r.data.campuses || []).map(c => ({
      id: c.id, shortName: c.shortName, isMain: MAIN_CAMPUSES.has(c.shortName)
    }));
    buildCampusSublist();
    updateActiveCampusesDisplay();
    await runOverview();
  } catch(e) { console.error(e); }
}

function buildCampusSublist() {
  const container = document.getElementById('campusSublist');
  container.innerHTML = '';
  [...campusList].sort((a,b) => a.shortName.localeCompare(b.shortName)).forEach(c => {
    const div = document.createElement('div');
    div.className = 'cb-item sub';
    div.dataset.campusId = c.id;
    div.dataset.isMain = c.isMain ? '1' : '0';
    div.addEventListener('click', () => {
      div.classList.toggle('checked');
      currentCampusGroup = 'custom';
      ['all','main','other','custom'].forEach(g => {
        const el = document.getElementById('cg-' + g);
        if (el) el.classList.toggle('selected', g === 'custom');
      });
      updateActiveCampusesDisplay();
    });
    div.innerHTML = '<div class="cb-box"><span class="cb-check">✓</span></div><span>' + c.shortName + '</span>';
    container.appendChild(div);
  });
  const customBtn = document.getElementById('cg-custom');
  if (customBtn) customBtn.style.display = '';
}

function selectCampusGroup(group) {
  currentCampusGroup = group;
  const sublist = document.getElementById('campusSublist');
  ['all','main','other','custom'].forEach(g => {
    const el = document.getElementById('cg-' + g);
    if (el) el.classList.toggle('selected', g === group);
  });
  if (group === 'all') {
    sublist.classList.remove('open');
    sublist.querySelectorAll('.cb-item').forEach(i => i.classList.remove('checked'));
  } else {
    sublist.classList.add('open');
    sublist.querySelectorAll('.cb-item').forEach(i => {
      const isMain = i.dataset.isMain === '1';
      i.classList.toggle('checked',
        group === 'main'  ? isMain :
        group === 'other' ? !isMain :
        i.classList.contains('checked')
      );
    });
  }
  updateActiveCampusesDisplay();
}

// Returns Set of campus shortNames for client-side filtering, or null = no filter.
function getSelectedCampusNames() {
  if (currentCampusGroup === 'all') return null;
  const checked = [...document.querySelectorAll('#campusSublist .cb-item.checked')];
  if (!checked.length) return null;
  return new Set(checked.map(i => {
    const c = campusList.find(c => c.id === i.dataset.campusId);
    return c ? c.shortName : null;
  }).filter(Boolean));
}

function buildAllowedCampusIds(sett) {
  const group = sett.campusGroup || 'all';
  if (group === 'all' || !campusList.length) return [];
  if (group === 'main')  return campusList.filter(c =>  c.isMain).map(c => c.id);
  if (group === 'other') return campusList.filter(c => !c.isMain).map(c => c.id);
  return sett.customCampusIds || [];
}

function updateActiveCampusesDisplay() {
  const wrap = document.getElementById('activeCampusesWrap');
  if (!wrap) return;
  if (currentCampusGroup === 'all') { wrap.style.display = 'none'; return; }
  let filtered = [];
  if (currentCampusGroup === 'main')       filtered = campusList.filter(c =>  c.isMain);
  else if (currentCampusGroup === 'other') filtered = campusList.filter(c => !c.isMain);
  else {
    const ids = new Set([...document.querySelectorAll('#campusSublist .cb-item.checked')].map(i => i.dataset.campusId));
    filtered = campusList.filter(c => ids.has(c.id));
  }
  if (!filtered.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = filtered.map(c =>
    '<span style="font-size:8px;padding:2px 6px;border-radius:3px;background:rgba(124,108,255,0.1);border:1px solid rgba(124,108,255,0.25);color:var(--muted2)">' + c.shortName + '</span>'
  ).join('');
}

// ── Project dropdown ──────────────────────────────────────────────
async function showProjectDropdown() {
  const dropdown = document.getElementById('projectDropdown');
  const keys = await store.keys('settings:');
  const pids = keys.map(k => k.replace('settings:', ''));
  if (!pids.length) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = pids.map(pid =>
    '<div class="proj-dropdown-item" data-pid="' + pid + '">' +
    '<div class="pdd-id">ID ' + pid + '</div>' +
    '<div class="pdd-name" id="pdd-name-' + pid + '">' + (_projectTitleCache[pid] || '...') + '</div></div>'
  ).join('');
  dropdown.querySelectorAll('.proj-dropdown-item').forEach(el =>
    el.addEventListener('mousedown', () => selectProjectFromDropdown(el.dataset.pid))
  );
  dropdown.style.display = '';
  pids.forEach(pid => {
    if (!_projectTitleCache[pid]) {
      apiGet('/v1/projects/' + pid).then(r => {
        if (r.status === 200 && r.data?.title) _projectTitleCache[pid] = r.data.title;
        else return apiGet('/v1/courses/' + pid).then(r2 => {
          if (r2.status === 200 && r2.data?.title) _projectTitleCache[pid] = r2.data.title;
        });
      }).then(() => {
        const el = document.getElementById('pdd-name-' + pid);
        if (el) el.textContent = _projectTitleCache[pid] || pid;
      }).catch(() => {});
    }
  });
}
function selectProjectFromDropdown(pid) {
  document.getElementById('projectId').value = pid;
  hideProjectDropdown();
  fetchProjectInfo(pid);
}
function hideProjectDropdown() { document.getElementById('projectDropdown').style.display = 'none'; }

let _projTimer = null;
function onProjectIdInput() {
  clearTimeout(_projTimer);
  hideProjectDropdown();
  const id = document.getElementById('projectId').value.trim();
  if (!id) { hideProjectCard(); return; }
  _projTimer = setTimeout(() => fetchProjectInfo(id), 500);
}

async function fetchProjectInfo(id) {
  if (!accessToken) return;
  try {
    let p = null, kind = 'PROJECT';
    const r = await apiGet('/v1/projects/' + id);
    if (r.status === 200 && r.data) { p = r.data; }
    else {
      const r2 = await apiGet('/v1/courses/' + id);
      if (r2.status === 200 && r2.data) { p = r2.data; kind = 'COURSE'; }
    }
    if (!p) { hideProjectCard(); return; }
    if (p.title) _projectTitleCache[id] = p.title;
    document.getElementById('pcTitle').textContent = p.title || '—';
    const chips = [[kind, kind === 'COURSE' ? '#4fc3f7' : 'var(--accent)']];
    if (p.xp != null) chips.push([p.xp + ' XP', 'var(--green)']);
    if (p.durationHours) chips.push([p.durationHours + 'h', 'var(--muted2)']);
    document.getElementById('pcChips').innerHTML = chips.map(([l,c]) =>
      '<span style="font-size:8px;padding:2px 6px;border-radius:3px;border:1px solid ' + c + '33;color:' + c + '">' + l + '</span>'
    ).join('');
    const desc = p.description || '';
    document.getElementById('pcDesc').textContent = desc.length > 100 ? desc.slice(0,100) + '…' : desc;
    document.getElementById('pcDesc').style.display = desc ? '' : 'none';
    document.getElementById('projectCard').style.display = 'flex';
  } catch(e) { hideProjectCard(); }
}
function hideProjectCard() { document.getElementById('projectCard').style.display = 'none'; }

// ── Search ────────────────────────────────────────────────────────
async function runSearch() {
  const statuses = [...document.querySelectorAll('[data-status].checked')].map(el => el.dataset.status);
  if (!statuses.length) { showToast('error', 'Выбери хотя бы один статус'); return; }
  currentProjectId = document.getElementById('projectId').value.trim();
  if (!currentProjectId) { showToast('error', 'Укажи Project ID'); return; }

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  showLoading();
  setProgress(0);
  document.getElementById('progressWrap').classList.add('visible');

  try {
    // Always get a fresh token before search
    await auth(_cachedCreds);

    // Collect all logins with retry on 401
    const loginStatusMap = new Map();
    for (const status of statuses) {
      let offset = 0;
      while (true) {
        const path = '/v1/projects/' + currentProjectId + '/participants?status=' + status + '&limit=1000&offset=' + offset;
        let r = await apiGet(path);
        // If still 401 after apiGet retry — get fresh token and try once more
        if (r.status === 401) {
          await auth(_cachedCreds);
          r = await apiGet(path);
        }
        if (r.status !== 200 || !r.data) break;
        (r.data.participants || []).forEach(p => { if (!loginStatusMap.has(p)) loginStatusMap.set(p, status); });
        if ((r.data.participants || []).length < 1000) break;
        offset += 1000;
      }
    }

    const logins = [...loginStatusMap.keys()];
    allStudents = [];
    const total = logins.length;

    if (total === 0) {
      showState('empty', 'Участники не найдены');
      btn.disabled = false; btn.textContent = '▶ НАЙТИ УЧАСТНИКОВ';
      document.getElementById('progressWrap').classList.remove('visible');
      return;
    }

    await loadSavedForProject(currentProjectId);

    // Build campus filter set from selected campuses (client-side filtering)
    const allowedCampusNames = getSelectedCampusNames();

    // Fetch student details
    for (let i = 0; i < logins.length; i += BATCH) {
      const batch = logins.slice(i, i + BATCH);
      btn.textContent = '⟳ ' + Math.min(i + BATCH, total) + '/' + total;
      setProgress((i + BATCH) / total * 100);
      const results = await Promise.allSettled(
        batch.map(login => fetchStudent(login, currentProjectId, loginStatusMap.get(login)))
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value && r.value.participantStatus === 'ACTIVE') {
          // Filter by campus client-side
          if (allowedCampusNames === null || allowedCampusNames.has(r.value.campus)) {
            allStudents.push(r.value);
          }
        }
      });
      if ((i + BATCH) % 100 === 0 || i + BATCH >= total) renderTable(allStudents);
    }

    document.getElementById('statTotal').textContent = allStudents.length;
    const newCount = allStudents.filter(s => !savedLogins.has(s.login)).length;
    document.getElementById('statNew').textContent = savedLogins.size > 0 ? newCount : '—';
    renderTable(allStudents);
    ['saveBtn','csvBtn','htmlBtn'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    showToast('success', '✓ Найдено ' + allStudents.length + ' участников');
    saveSettings();

  } catch(e) {
    showState('error', '⚠ ' + e.message);
    showToast('error', e.message);
  }

  btn.disabled = false; btn.textContent = '▶ НАЙТИ УЧАСТНИКОВ';
  document.getElementById('progressWrap').classList.remove('visible');
}

// Exact port of C# fetchStudent — always returns object, caller filters by participantStatus === ACTIVE
async function fetchStudent(login, projectId, searchStatus) {
  try {
    const [infoR, projR] = await Promise.all([
      apiGet('/v1/participants/' + login),
      apiGet('/v1/participants/' + login + '/projects/' + projectId),
    ]);
    const info = infoR.status === 200 ? infoR.data : null;
    const proj = projR.status === 200 ? projR.data : null;
    return {
      login,
      level:             info?.level ?? '—',
      campus:            info?.campus?.shortName ?? '—',
      participantStatus: info?.status ?? '—',
      expValue:          info?.expValue ?? '—',
      projectStatus:     proj?.status ?? searchStatus ?? '—',
      finalPercentage:   proj?.finalPercentage ?? null,
      completionDate:    proj?.completionDateTime
        ? new Date(proj.completionDateTime).toLocaleDateString('ru-RU') : null,
      detailLoaded: true,
    };
  } catch(e) {
    return { login, level:'—', campus:'—', participantStatus:'—', expValue:'—',
      projectStatus: searchStatus ?? '—', finalPercentage:null, completionDate:null, detailLoaded:false };
  }
}

// ── Detail panel ──────────────────────────────────────────────────
function loadDetail(login) {
  const s = allStudents.find(s => s.login === login);
  if (!s) return;
  document.getElementById('detailLogin').textContent = login;
  const rows = [
    ['Логин', s.login], ['Кампус', s.campus], ['Уровень', s.level],
    ['XP', typeof s.expValue === 'number' ? s.expValue.toLocaleString() : s.expValue],
    ['Статус участника', s.participantStatus], ['Статус проекта', s.projectStatus],
    ['Выполнение', s.finalPercentage != null ? s.finalPercentage + '%' : '—'],
    ['Дата завершения', s.completionDate ?? '—'],
  ];
  document.getElementById('detailBody').innerHTML =
    '<div><div class="detail-section-title">// данные участника</div>' +
    rows.map(([k,v]) =>
      '<div class="detail-row"><span class="detail-key">' + k + '</span><span class="detail-val">' + v + '</span></div>'
    ).join('') + '</div>' +
    '<a href="https://edu.21-school.ru/profile/' + s.login + '" target="_blank" ' +
    'style="display:block;text-align:center;padding:8px;border:1px solid var(--border2);border-radius:6px;color:var(--muted2);font-size:10px;text-decoration:none">' +
    '↗ Открыть профиль</a>';
  document.getElementById('detailPanel').classList.add('open');
}
function closeDetail() { document.getElementById('detailPanel').classList.remove('open'); }

// ── Table ─────────────────────────────────────────────────────────
const COL_KEYS = ['login','campus','level','xp','projectStatus','participantStatus'];
function renderTable(students) {
  const q = document.getElementById('searchFilter').value.toLowerCase();
  filteredList = q ? students.filter(s => s.login.toLowerCase().includes(q)) : students.slice();
  if (sortCol) {
    filteredList.sort((a,b) => {
      let av = getSortVal(a,sortCol), bv = getSortVal(b,sortCol);
      return av < bv ? (sortDir === 'asc' ? -1 : 1) : av > bv ? (sortDir === 'asc' ? 1 : -1) : 0;
    });
  }
  if (!filteredList.length) { showState('empty', 'Участники не найдены'); return; }
  const labels = ['ЛОГИН','КАМПУС','LVL','XP','СТАТУС ПРОЕКТА','СТАТУС'];
  showTable();
  document.getElementById('tableWrap').innerHTML =
    '<div class="table-head">' +
    COL_KEYS.map((k,i) =>
      '<div class="' + (sortCol===k ? (sortDir==='asc'?'sort-asc':'sort-desc') : '') + '" data-col="' + k + '">' + labels[i] + '</div>'
    ).join('') + '</div>' +
    '<div id="rowsContainer">' + filteredList.map(buildRowHtml).join('') + '</div>';
  document.querySelectorAll('.table-head [data-col]').forEach(el =>
    el.addEventListener('click', () => sortBy(el.dataset.col))
  );
  document.querySelectorAll('#rowsContainer .student-row').forEach(el =>
    el.addEventListener('click', () => loadDetail(el.dataset.login))
  );
}
function buildRowHtml(s) {
  const isNew = savedLogins.size > 0 && !savedLogins.has(s.login);
  const pct  = s.finalPercentage != null ? ' <span style="color:var(--muted2);font-size:9px">' + s.finalPercentage + '%</span>' : '';
  const date = s.completionDate ? '<div style="font-size:8px;color:var(--muted);margin-top:1px">' + s.completionDate + '</div>' : '';
  return '<div class="student-row ' + (isNew ? 'is-new' : '') + '" data-login="' + s.login + '">' +
    '<div class="student-login">' + (isNew ? '<span class="new-badge">NEW</span>' : '') + s.login + '</div>' +
    '<div class="cell">' + s.campus + '</div>' +
    '<div class="cell"><span class="level-badge">' + s.level + '</span></div>' +
    '<div class="cell">' + (typeof s.expValue === 'number' ? s.expValue.toLocaleString() : s.expValue) + '</div>' +
    '<div class="cell"><span class="chip chip-' + s.projectStatus + '">' + s.projectStatus + '</span>' + pct + date + '</div>' +
    '<div class="cell"><span class="pdot pdot-' + s.participantStatus + '"></span>' + s.participantStatus + '</div></div>';
}
function getSortVal(s, col) {
  switch(col) {
    case 'login': return s.login.toLowerCase();
    case 'campus': return s.campus.toLowerCase();
    case 'level': return typeof s.level === 'number' ? s.level : -1;
    case 'xp': return typeof s.expValue === 'number' ? s.expValue : -1;
    default: return s[col] || '';
  }
}
function sortBy(col) {
  sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
  sortCol = col;
  renderTable(allStudents);
}
function filterTable() { if (allStudents.length) renderTable(allStudents); }

// ── Save ──────────────────────────────────────────────────────────
async function loadSavedForProject(projectId) {
  const logins = await store.get('saved:' + projectId);
  savedLogins = new Set(Array.isArray(logins) ? logins : []);
  if (savedLogins.size > 0) showToast('info', '📂 Загружено ' + savedLogins.size + ' сохранённых');
}
async function saveList() {
  if (!currentProjectId) return;
  const logins = allStudents.map(s => s.login);
  await store.set('saved:' + currentProjectId, logins);
  savedLogins = new Set(logins);
  document.getElementById('statNew').textContent = '—';
  renderTable(allStudents);
  showToast('success', '✓ Сохранено ' + logins.length + ' участников');
}
async function clearSaved() {
  if (!currentProjectId) return;
  await store.remove('saved:' + currentProjectId);
  savedLogins.clear();
  document.getElementById('statNew').textContent = '—';
  if (allStudents.length) renderTable(allStudents);
  showToast('info', 'Сохранённый список очищен');
}

// ── Settings ──────────────────────────────────────────────────────
function collectSettings() {
  return {
    campusGroup: currentCampusGroup,
    customCampusIds: currentCampusGroup === 'custom'
      ? [...document.querySelectorAll('#campusSublist .cb-item.checked')].map(i => i.dataset.campusId) : [],
    statuses: [...document.querySelectorAll('[data-status].checked')].map(el => el.dataset.status),
  };
}
async function saveSettings() {
  if (!currentProjectId) return;
  await store.set('settings:' + currentProjectId, collectSettings());
}
async function applySettings(sett) {
  if (!sett) return;
  if (sett.statuses?.length)
    document.querySelectorAll('[data-status]').forEach(el =>
      el.classList.toggle('checked', sett.statuses.includes(el.dataset.status))
    );
  if (sett.campusGroup) {
    selectCampusGroup(sett.campusGroup);
    if (sett.campusGroup === 'custom' && sett.customCampusIds?.length) {
      const ids = new Set(sett.customCampusIds);
      document.querySelectorAll('#campusSublist .cb-item').forEach(i =>
        i.classList.toggle('checked', ids.has(i.dataset.campusId))
      );
      updateActiveCampusesDisplay();
    }
  }
}

// ── Overview ──────────────────────────────────────────────────────
class Semaphore {
  constructor(n) { this._n = n; this._q = []; this._a = 0; }
  acquire() {
    if (this._a < this._n) { this._a++; return Promise.resolve(); }
    return new Promise(r => this._q.push(r)).then(() => { this._a++; });
  }
  release() { this._a--; if (this._q.length) this._q.shift()(); }
}

async function runOverview() {
  const keys = await store.keys('settings:');
  const projectIds = keys.map(k => k.replace('settings:', ''));
  if (!projectIds.length) {
    showState('info', 'Сохранённых проектов нет. Введи Project ID и нажми «Найти»');
    return;
  }
  showOverview();
  const grid = document.getElementById('overviewGrid');
  grid.innerHTML = '';
  for (const pid of projectIds) {
    const card = document.createElement('div');
    card.className = 'ov-card'; card.id = 'ovc-' + pid;
    card.innerHTML =
      '<div class="ov-card-top"><div>' +
      '<div class="ov-project-id">PROJECT ' + pid + '</div>' +
      '<div class="ov-project-name" id="ovc-name-' + pid + '">Загрузка...</div></div>' +
      '<div style="display:flex;align-items:center;gap:5px">' +
      '<div class="ov-spinner" id="ovc-spin-' + pid + '"></div>' +
      '<button class="ov-open-btn">Открыть →</button>' +
      '<button class="ov-delete-btn" title="Удалить">✕</button>' +
      '</div></div><div class="ov-stats" id="ovc-stats-' + pid + '"></div>';
    card.querySelector('.ov-open-btn').addEventListener('click', () => openProjectFromOverview(pid));
    card.querySelector('.ov-delete-btn').addEventListener('click', e => { e.stopPropagation(); deleteProjectSave(pid); });
    grid.appendChild(card);
  }
  const sem = new Semaphore(5);
  await Promise.allSettled(projectIds.map(async pid => {
    await sem.acquire();
    try { await loadOverviewCard(pid); } finally { sem.release(); }
  }));
}

async function loadOverviewCard(pid) {
  try {
    // Ensure fresh token before API calls
    if (!accessToken) await auth(_cachedCreds);

    const [sett, savedArr] = await Promise.all([
      store.get('settings:' + pid),
      store.get('saved:' + pid),
    ]);
    const settings = sett || {};
    const statuses = settings.statuses?.length ? settings.statuses : ['ACCEPTED','IN_PROGRESS','IN_REVIEWS','REGISTERED'];
    const savedLogins = new Set(Array.isArray(savedArr) ? savedArr : []);

    // Build allowed campus names for client-side filtering
    const campusGroup = settings.campusGroup || 'all';
    let allowedCampusNames = null; // null = no filter
    if (campusGroup === 'main') {
      allowedCampusNames = new Set(MAIN_CAMPUSES);
    } else if (campusGroup === 'other') {
      if (campusList.length) allowedCampusNames = new Set(campusList.filter(c => !c.isMain).map(c => c.shortName));
    } else if (campusGroup === 'custom' && settings.customCampusIds?.length) {
      allowedCampusNames = new Set(
        settings.customCampusIds.map(id => campusList.find(c => c.id === id)?.shortName).filter(Boolean)
      );
    }

    // Fetch project name + all logins in parallel
    const namePromise = apiGet('/v1/projects/' + pid).then(async rp => {
      if (rp.status === 200 && rp.data?.title) return rp.data.title;
      const rc = await apiGet('/v1/courses/' + pid);
      return (rc.status === 200 && rc.data?.title) ? rc.data.title : pid;
    });

    const loginSet = new Set();
    const [name] = await Promise.all([
      namePromise,
      Promise.all(statuses.map(async status => {
        let offset = 0;
        while (true) {
          const path = '/v1/projects/' + pid + '/participants?status=' + status + '&limit=1000&offset=' + offset;
          const r = await apiGet(path);
          if (r.status !== 200 || !r.data) break;
          (r.data.participants || []).forEach(l => loginSet.add(l));
          if ((r.data.participants || []).length < 1000) break;
          offset += 1000;
        }
      }))
    ]);

    const nameEl = document.getElementById('ovc-name-' + pid);
    if (nameEl) nameEl.textContent = name;
    _projectTitleCache[pid] = name;

    // Fetch participant info to get campus — parallel with semaphore
    const sem = new Semaphore(10);
    const activeInCampus = [];
    await Promise.allSettled([...loginSet].map(async login => {
      await sem.acquire();
      try {
        const r = await apiGet('/v1/participants/' + login);
        if (r.status !== 200 || !r.data) return;
        if (r.data.status !== 'ACTIVE') return;
        if (allowedCampusNames !== null && !allowedCampusNames.has(r.data.campus?.shortName)) return;
        activeInCampus.push(login);
      } finally { sem.release(); }
    }));

    const spinEl = document.getElementById('ovc-spin-' + pid);
    if (spinEl) spinEl.style.display = 'none';

    const newCount = savedLogins.size > 0 ? activeInCampus.filter(l => !savedLogins.has(l)).length : 0;
    const statsEl = document.getElementById('ovc-stats-' + pid);
    if (statsEl) {
      let html = '<div class="ov-stat"><div class="ov-stat-val accent">' + activeInCampus.length + '</div><div class="ov-stat-lbl">Участников</div></div>';
      if (savedLogins.size > 0) {
        html += '<div style="width:1px;height:28px;background:var(--border)"></div>';
        html += '<div class="ov-stat"><div class="ov-stat-val" style="' + (newCount > 0 ? 'color:var(--green)' : 'color:var(--muted)') + '">' + newCount + '</div><div class="ov-stat-lbl">Новых</div></div>';
        html += '<div style="width:1px;height:28px;background:var(--border)"></div>';
        html += '<div class="ov-stat"><div class="ov-stat-val" style="color:var(--muted2)">' + savedLogins.size + '</div><div class="ov-stat-lbl">Сохранено</div></div>';
      }
      statsEl.innerHTML = html;
    }
    if (newCount > 0) document.getElementById('ovc-' + pid)?.classList.add('has-new');
  } catch(e) {
    const spinEl = document.getElementById('ovc-spin-' + pid);
    if (spinEl) spinEl.style.display = 'none';
    const nameEl = document.getElementById('ovc-name-' + pid);
    if (nameEl && nameEl.textContent === 'Загрузка...') nameEl.textContent = 'Ошибка';
  }
}

async function openProjectFromOverview(pid) {
  const sett = await store.get('settings:' + pid);
  await applySettings(sett);
  document.getElementById('projectId').value = pid;
  fetchProjectInfo(pid);
  currentProjectId = pid;
  runSearch();
}

async function deleteProjectSave(pid) {
  if (!confirm('Удалить сохранённый поиск для проекта ' + pid + '?')) return;
  await store.remove('saved:' + pid);
  await store.remove('settings:' + pid);
  document.getElementById('ovc-' + pid)?.remove();
  const grid = document.getElementById('overviewGrid');
  if (grid && !grid.children.length)
    showState('info', 'Сохранённых проектов нет. Введи Project ID и нажми «Найти»');
}

function backToOverview() { showOverview(); }

// ── Export ────────────────────────────────────────────────────────
function dl(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8;' }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}
function exportCsv() {
  if (!allStudents.length) return;
  dl('\ufeff' + ['login,campus,level,xp,projectStatus,participantStatus,finalPercentage,completionDate',
    ...allStudents.map(s => [s.login,s.campus,s.level,s.expValue,s.projectStatus,s.participantStatus,s.finalPercentage??'',s.completionDate??''].join(','))
  ].join('\n'), 'text/csv', 's21_' + currentProjectId + '_' + Date.now() + '.csv');
  showToast('success', '✓ CSV скачан');
}
function exportHtml() {
  if (!allStudents.length) return;
  const rows = (filteredList.length ? filteredList : allStudents).map(s => {
    const isNew = savedLogins.size > 0 && !savedLogins.has(s.login);
    return '<tr' + (isNew ? ' class="new"' : '') + '><td>' + (isNew ? '<b>NEW</b> ' : '') + s.login + '</td><td>' + s.campus + '</td><td>' + s.level + '</td><td>' + (typeof s.expValue === 'number' ? s.expValue.toLocaleString() : s.expValue) + '</td><td>' + s.projectStatus + (s.finalPercentage != null ? ' ' + s.finalPercentage + '%' : '') + (s.completionDate ? '<br><small>' + s.completionDate + '</small>' : '') + '</td><td>' + s.participantStatus + '</td></tr>';
  }).join('');
  dl('<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>S21 — ' + currentProjectId + '</title><style>body{font-family:monospace;background:#060608;color:#e2e2f0;padding:24px}h1{font-size:16px;color:#7c6cff}.meta{font-size:11px;color:#4a4a6a;margin-bottom:20px}table{border-collapse:collapse;width:100%;font-size:12px}th{background:#0d0d12;color:#4a4a6a;font-size:9px;letter-spacing:2px;text-transform:uppercase;padding:10px 12px;text-align:left;border-bottom:1px solid #1a1a28}td{padding:10px 12px;border-bottom:1px solid #1a1a28}tr.new td{background:rgba(0,214,143,0.06)}tr.new td:first-child{border-left:3px solid #00d68f}small{color:#4a4a6a;font-size:9px}</style></head><body><h1>S21 TRACKER — PROJECT ' + currentProjectId + '</h1><div class="meta">Экспорт: ' + new Date().toLocaleString('ru-RU') + ' · Участников: ' + allStudents.length + '</div><table><thead><tr><th>ЛОГИН</th><th>КАМПУС</th><th>LVL</th><th>XP</th><th>СТАТУС ПРОЕКТА</th><th>СТАТУС</th></tr></thead><tbody>' + rows + '</tbody></table></body></html>',
    'text/html', 's21_' + currentProjectId + '_' + Date.now() + '.html');
  showToast('success', '✓ HTML скачан');
}

// ── UI ────────────────────────────────────────────────────────────
function showOverview() {
  document.getElementById('overviewWrap').style.display = 'block';
  document.getElementById('tableWrap').style.display = 'none';
  document.getElementById('backToOverviewBtn').style.display = 'none';
}
function showTable() {
  document.getElementById('overviewWrap').style.display = 'none';
  document.getElementById('tableWrap').style.display = 'block';
  document.getElementById('backToOverviewBtn').style.display = 'block';
}
function showLoading() {
  showTable();
  document.getElementById('tableWrap').innerHTML =
    '<div class="state-box"><div class="spinner"></div><div class="state-text">Загружаю данные...</div></div>';
}
function showState(type, text) {
  showTable();
  const icons = { error:'⚠', empty:'◎', info:'◈' };
  document.getElementById('tableWrap').innerHTML =
    '<div class="state-box"><div class="state-icon">' + (icons[type]||'◎') + '</div><div class="state-text">' + text + '</div></div>';
}
function setProgress(pct) { document.getElementById('progressBar').style.width = pct + '%'; }

let _toastTimer;
function showToast(type, text) {
  const t = document.getElementById('toast');
  document.getElementById('toastIcon').textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  document.getElementById('toastMsg').textContent = text;
  t.className = 'toast ' + type + ' show';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
