/* ============================================================
   Волна v2.1 — клиентская логика
   ============================================================ */

"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  user: null,
  session: null,
  tracks: [],
  route: { name: "home", path: "/" },
  query: "",
  currentId: null,
  playing: false,
  uploadFile: null,
  editingId: null,
  playCounted: new Set(),
  pendingPath: null,
  seekDragging: false,
  detail: null,
  profile: null,
  routeSeq: 0,
};

const MAX_UPLOAD = 80 * 1024 * 1024;
const ALLOWED_EXT = [
  ".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a",
  ".mp4", ".aac", ".flac", ".webm",
];

const numberFmt = new Intl.NumberFormat("ru-RU");
const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "short", year: "numeric",
});
const dateTimeFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit",
});

const ICON_PLAY =
  '<svg class="icon-play" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5.14v13.72c0 .86.94 1.39 1.68.95l10.72-6.86a1.1 1.1 0 0 0 0-1.9L9.68 4.19A1.1 1.1 0 0 0 8 5.14Z" fill="currentColor"/></svg>';
const ICON_PAUSE =
  '<svg class="icon-pause" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1.5" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1.5" fill="currentColor"/></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m4 20 4.5-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_HEART =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_HEART_FILLED =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" fill="currentColor"/></svg>';
const ICON_COMMENT =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const ICON_COMMENT_SMALL =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_HEART_SMALL =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 0 0-7.7 0L12 5.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.7a5.4 5.4 0 0 0 0-7.7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_SHARE =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="18" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="19" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m8.7 10.7 6.6-4.2M8.7 13.3l6.6 4.2" stroke="currentColor" stroke-width="1.7"/></svg>';

/* ---------- Утилиты ---------- */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#8b5cf6";
}

function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) {
    return `${(size / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} КБ`;
  }
  return `${(size / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateFmt.format(date);
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFmt.format(date);
}

function relativeTime(iso) {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diff < 60) return "только что";
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} дн назад`;
  return formatDate(iso);
}

function formatNumber(value) {
  return numberFmt.format(Number(value) || 0);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function setRangeFill(input, percent) {
  input.style.setProperty("--fill", `${Math.max(0, Math.min(100, percent))}%`);
}

function encodeUsername(username) {
  return encodeURIComponent(String(username || ""));
}

function trackPath(trackId) {
  return `/track/${trackId}`;
}

function userPath(username) {
  return `/u/${encodeUsername(username)}`;
}

function trackById(id) {
  return state.tracks.find((track) => track.id === id)
    || (state.detail && state.detail.track && state.detail.track.id === id ? state.detail.track : null)
    || (state.profile && state.profile.tracks ? state.profile.tracks.find((track) => track.id === id) : null)
    || null;
}

function avatarElement(id, user) {
  const el = $("#" + id);
  if (!el) return;
  el.textContent = user.avatar || "🎵";
  el.style.setProperty("--accent", safeColor(user.accent));
}

function pageLoader(text) {
  return `<div class="page-loader"><span class="loader-ring"></span><span>${esc(text)}</span></div>`;
}

/* ---------- API ---------- */

async function api(path, options = {}) {
  const opts = { credentials: "same-origin", ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch(path, opts);
  } catch (error) {
    throw new Error("Сервер недоступен. Проверьте, что он запущен.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    const message = data && data.error ? data.error : `Ошибка ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

/* ---------- Тосты ---------- */

function toast(message, type = "info", timeout = 3400) {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast is-${type}`;
  el.textContent = message;
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 240);
  }, timeout);
}

/* ---------- Мета страницы ---------- */

function setMetaContent(selector, value) {
  const el = $(selector);
  if (el) el.setAttribute("content", value);
}

function setPageMeta(title, description, type = "website") {
  document.title = title;
  setMetaContent('meta[name="description"]', description);
  setMetaContent('meta[property="og:title"]', title);
  setMetaContent('meta[property="og:description"]', description);
  setMetaContent('meta[property="og:type"]', type);
}

/* ---------- Роутер ---------- */

function parseRoute(path = location.pathname) {
  const url = new URL(path, location.origin);
  let pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/index.html") pathname = "/";
  if (pathname === "/") return { name: "home", path: "/" };
  if (pathname === "/upload") return { name: "upload", path: pathname };
  if (pathname === "/account") return { name: "account", path: pathname };
  const trackMatch = pathname.match(/^\/track\/([a-f0-9]+)$/);
  if (trackMatch) return { name: "track", id: trackMatch[1], path: pathname };
  const userMatch = pathname.match(/^\/u\/([^/]+)$/);
  if (userMatch) {
    let username = userMatch[1];
    try { username = decodeURIComponent(username); } catch (error) { /* as-is */ }
    return { name: "user", username, path: pathname };
  }
  return { name: "notfound", path: pathname };
}

function isProtectedRoute(route) {
  return route.name === "upload" || route.name === "account";
}

function navigate(path, options = {}) {
  const url = new URL(path, location.origin);
  const route = parseRoute(url.pathname);
  if (isProtectedRoute(route) && !state.user) {
    openAuth("login", url.pathname + url.search);
    return;
  }
  if (url.pathname === location.pathname && url.search === location.search && options.force !== true) {
    if (url.hash && location.hash !== url.hash) {
      history.pushState({}, "", url.pathname + url.search + url.hash);
    }
    renderRoute({ scroll: options.scroll !== false });
    return;
  }
  if (options.replace) history.replaceState({}, "", url.pathname + url.search + url.hash);
  else history.pushState({}, "", url.pathname + url.search + url.hash);
  renderRoute({ scroll: options.scroll !== false });
}

function showView(name) {
  $$(".view").forEach((view) => {
    const active = view.id === `view-${name}`;
    view.hidden = !active;
    view.classList.toggle("is-active", active);
  });
}

function setActiveNav(name) {
  const target = ["upload", "account"].includes(name) ? name : "home";
  $$(".nav-link[data-nav]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.nav === target);
  });
}

function showNotFound(message = "Страница не найдена, удалена или ссылка устарела.") {
  showView("notfound");
  setActiveNav("home");
  const text = $("#view-notfound .not-found p");
  if (text) text.textContent = message;
  setPageMeta("404 — Волна", message);
}

async function renderRoute(options = {}) {
  const seq = ++state.routeSeq;
  const route = parseRoute();
  state.route = route;

  if (isProtectedRoute(route) && !state.user) {
    if (location.pathname !== "/") history.replaceState({}, "", "/");
    showView("home");
    setActiveNav("home");
    await ensureTracks();
    if (seq !== state.routeSeq) return;
    renderHome();
    openAuth("login", route.path);
    return;
  }

  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "instant" });

  if (route.name === "home") {
    showView("home");
    setActiveNav("home");
    await ensureTracks();
    if (seq !== state.routeSeq) return;
    renderHome();
    setPageMeta(
      "Волна — аудио без границ",
      "Слушайте треки без регистрации, скачивайте бесплатно и делитесь своими звуками."
    );
    return;
  }

  if (route.name === "upload") {
    showView("upload");
    setActiveNav("upload");
    renderUploadState();
    updateTitleCounter();
    setPageMeta("Загрузить трек — Волна", "Опубликуйте свой трек в ленте Волны.");
    return;
  }

  if (route.name === "account") {
    try {
      await loadMe();
    } catch (error) {
      toast(error.message, "error");
    }
    if (seq !== state.routeSeq) return;
    if (!state.user) {
      if (location.pathname !== "/") history.replaceState({}, "", "/");
      showView("home");
      setActiveNav("home");
      renderHome();
      openAuth("login", route.path);
      return;
    }
    showView("account");
    setActiveNav("account");
    renderAccount();
    setPageMeta("Настройки аккаунта — Волна", "Профиль, cookie-сессия и активность на Волне.");
    return;
  }

  if (route.name === "track") {
    showView("track");
    setActiveNav("home");
    await renderTrackRoute(route.id, seq);
    return;
  }

  if (route.name === "user") {
    showView("user");
    setActiveNav("home");
    await renderUserRoute(route.username, seq);
    return;
  }

  showNotFound();
}

async function ensureTracks(force = false) {
  if (!force && state.tracks.length) return;
  try {
    const data = await api("/api/tracks");
    state.tracks = data.tracks;
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ---------- Авторизация ---------- */

function renderAuthArea() {
  const area = $("#authArea");
  if (state.user) {
    const user = state.user;
    area.innerHTML = `
      <a class="user-chip" id="userChip" href="/account" data-link title="Настройки аккаунта">
        <span class="avatar avatar-sm" style="--accent:${safeColor(user.accent)}">${esc(user.avatar || "🎵")}</span>
        <span class="handle-mini">@${esc(user.username)}</span>
      </a>
      <button class="icon-action" id="headerLogout" type="button" title="Выйти" aria-label="Выйти">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M10 12h10m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
  } else {
    area.innerHTML = '<button class="btn btn-ghost btn-sm" id="loginOpen" type="button">Войти</button>';
  }
}

function openAuth(tab = "login", pendingPath = null) {
  state.pendingPath = pendingPath;
  $("#authModal").hidden = false;
  document.body.classList.add("modal-open");
  switchAuthTab(tab);
  setTimeout(() => {
    const input = tab === "login" ? $("#loginUsername") : $("#registerUsername");
    if (input) input.focus();
  }, 60);
}

function closeAuth() {
  $("#authModal").hidden = true;
  state.pendingPath = null;
  syncBodyLock();
}

function switchAuthTab(tab) {
  const isLogin = tab === "login";
  $$("[data-auth-tab]").forEach((btn) => {
    const active = btn.dataset.authTab === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  $("#loginForm").hidden = !isLogin;
  $("#registerForm").hidden = isLogin;
  $("#authTitle").textContent = isLogin ? "С возвращением" : "Создать аккаунт";
  $("#authSubtitle").textContent = isLogin
    ? "Войдите, чтобы загружать треки, комментировать и настраивать профиль."
    : "Минута — и вы сможете делиться звуками и общаться с авторами.";
}

function syncBodyLock() {
  const locked = !$("#authModal").hidden || !$("#editModal").hidden;
  document.body.classList.toggle("modal-open", locked);
}

async function afterAuth(user, session, greeting) {
  const target = state.pendingPath;
  state.pendingPath = null;
  state.user = user;
  state.session = session;
  $("#authModal").hidden = true;
  syncBodyLock();
  renderAuthArea();
  await ensureTracks(true);
  if (target) {
    navigate(target, { replace: true });
  } else {
    renderRoute({ scroll: false });
  }
  toast(greeting, "success");
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type=submit]", form);
  const username = $("#loginUsername").value.trim();
  const password = $("#loginPassword").value;
  if (!username || !password) {
    toast("Введите имя пользователя и пароль", "error");
    return;
  }
  button.disabled = true;
  try {
    const data = await api("/api/login", { method: "POST", body: { username, password } });
    form.reset();
    await afterAuth(data.user, data.session, `С возвращением, ${data.user.display_name}!`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type=submit]", form);
  const payload = {
    username: $("#registerUsername").value.trim(),
    display_name: $("#registerDisplayName").value.trim(),
    password: $("#registerPassword").value,
  };
  if (!payload.username || !payload.password) {
    toast("Заполните имя пользователя и пароль", "error");
    return;
  }
  if (payload.password.length < 6) {
    toast("Пароль должен содержать минимум 6 символов", "error");
    return;
  }
  button.disabled = true;
  try {
    const data = await api("/api/register", { method: "POST", body: payload });
    form.reset();
    await afterAuth(data.user, data.session, `Аккаунт создан. Добро пожаловать, ${data.user.display_name}!`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (error) {
    /* Кука всё равно будет очищена локально. */
  }
  state.user = null;
  state.session = null;
  renderAuthArea();
  await ensureTracks(true);
  if (state.route.name === "account" || state.route.name === "upload") {
    navigate("/", { replace: true });
  } else {
    renderRoute({ scroll: false });
  }
  toast("Вы вышли из аккаунта");
}

function handleAuthFailure(error) {
  if (error && error.status === 401) {
    state.user = null;
    state.session = null;
    renderAuthArea();
    openAuth("login", location.pathname);
    return true;
  }
  return false;
}

/* ---------- Данные ---------- */

async function loadMe() {
  const data = await api("/api/me");
  state.user = data.user;
  state.session = data.session;
  renderAuthArea();
}

async function loadTracks() {
  const data = await api("/api/tracks");
  state.tracks = data.tracks;
  if (state.route.name === "home") renderHome();
  if (state.route.name === "account") renderAccount();
}

/* ---------- Лента ---------- */

function filteredTracks() {
  if (!state.query) return state.tracks;
  const q = state.query.toLowerCase();
  return state.tracks.filter((track) =>
    track.title.toLowerCase().includes(q)
    || (track.description || "").toLowerCase().includes(q)
    || track.author.username.toLowerCase().includes(q)
    || track.author.display_name.toLowerCase().includes(q)
  );
}

function trackCard(track) {
  const playing = state.currentId === track.id && !audioEl.paused;
  const accent = safeColor(track.author.accent);
  const description = track.description
    ? `<p class="track-desc">${esc(track.description)}</p>`
    : "";
  const ownerActions = track.mine
    ? `<div class="owner-actions">
         <button class="icon-action" type="button" data-edit="${track.id}" title="Редактировать" aria-label="Редактировать трек">${ICON_EDIT}</button>
         <button class="icon-action danger" type="button" data-delete="${track.id}" title="Удалить" aria-label="Удалить трек">${ICON_TRASH}</button>
       </div>`
    : "";

  return `
    <article class="track${playing ? " is-playing" : ""}" data-track-id="${track.id}" style="--accent:${accent}">
      <div class="cover">
        <span class="cover-emoji">${esc(track.author.avatar || "🎵")}</span>
        <div class="cover-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <button class="play-fab" type="button" data-play="${track.id}" aria-label="Слушать трек">
          ${ICON_PLAY}${ICON_PAUSE}
        </button>
      </div>
      <div class="track-body">
        <div class="track-title-row">
          <a class="track-title" href="${trackPath(track.id)}" data-link title="${esc(track.title)}">${esc(track.title)}</a>
          <a class="title-open" href="${trackPath(track.id)}" data-link aria-label="Открыть страницу трека">↗</a>
        </div>
        <a class="author-btn" href="${userPath(track.author.username)}" data-link title="Профиль автора">
          <span class="mini-avatar">${esc(track.author.avatar || "🎵")}</span>
          <span>${esc(track.author.display_name)}</span>
        </a>
        ${description}
        <div class="track-meta">
          <span>${formatSize(track.size)}</span>
          <span class="dot">·</span>
          <span class="plays" data-plays-for="${track.id}">${formatNumber(track.plays)} ${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")}</span>
          <span class="dot">·</span>
          <span class="metric" data-likes-for="${track.id}" title="Лайки">${ICON_HEART_SMALL}${formatNumber(track.likes || 0)}</span>
          <span class="metric" data-comments-for="${track.id}" title="Комментарии">${ICON_COMMENT_SMALL}${formatNumber(track.comment_count || 0)}</span>
        </div>
        <div class="track-actions">
          <button class="chip-btn play" type="button" data-play="${track.id}">
            ${ICON_PLAY}${ICON_PAUSE}
            <span class="label-play">Слушать</span><span class="label-pause">Пауза</span>
          </button>
          <a class="chip-btn download" href="/api/tracks/${track.id}/download" data-download="${track.id}" download>
            ${ICON_DOWNLOAD}<span>Скачать</span>
          </a>
          ${ownerActions}
        </div>
      </div>
    </article>`;
}

function renderHome() {
  renderTracks();
  updateStats();
}

function renderTracks() {
  const grid = $("#trackGrid");
  const empty = $("#emptyState");
  const list = filteredTracks();
  if (!grid) return;

  grid.innerHTML = list.map(trackCard).join("");
  grid.hidden = list.length === 0;
  empty.hidden = list.length > 0;

  if (list.length === 0) {
    $("#emptyTitle").textContent = state.query ? "Ничего не нашлось" : "Пока тихо";
    $("#emptyText").textContent = state.query
      ? "Попробуйте изменить запрос — возможно, трек называется иначе."
      : "Здесь появятся треки — станьте первым, кто поделится звуком.";
  }

  $("#feedSubtitle").textContent = state.query
    ? `Найдено: ${formatNumber(list.length)} ${plural(list.length, "трек", "трека", "треков")}`
    : state.tracks.length
      ? `Свежие загрузки сообщества · ${formatNumber(state.tracks.length)} ${plural(state.tracks.length, "трек", "трека", "треков")}`
      : "Свежие загрузки сообщества";

  syncPlaybackUI();
}

function updateStats() {
  const trackCount = state.tracks.length;
  const playCount = state.tracks.reduce((total, track) => total + (track.plays || 0), 0);
  const authorCount = new Set(state.tracks.map((track) => track.author.username)).size;

  $("#statTracks").textContent = formatNumber(trackCount);
  $("#statPlays").textContent = formatNumber(playCount);
  $("#statAuthors").textContent = formatNumber(authorCount);
  $("#statTracksLabel").textContent = plural(trackCount, "трек", "трека", "треков");
  $("#statPlaysLabel").textContent = plural(playCount, "прослушивание", "прослушивания", "прослушиваний");
  $("#statAuthorsLabel").textContent = plural(authorCount, "автор", "автора", "авторов");
}

function updateTrackMeta(track) {
  $$(`[data-plays-for="${track.id}"]`).forEach((el) => {
    el.textContent = `${formatNumber(track.plays)} ${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")}`;
  });
  $$(`[data-likes-for="${track.id}"]`).forEach((el) => {
    el.innerHTML = `${ICON_HEART_SMALL}${formatNumber(track.likes || 0)}`;
  });
  $$(`[data-comments-for="${track.id}"]`).forEach((el) => {
    el.innerHTML = `${ICON_COMMENT_SMALL}${formatNumber(track.comment_count || 0)}`;
  });
  updateStats();
  updateDetailStats();
}

/* ---------- Плеер ---------- */

const audioEl = $("#audio");
const playerBar = $("#playerBar");
const mixerEl = $("#mixer");
const mixerStatus = $("#mixerStatus");

function setPlayerAccent(track) {
  playerBar.style.setProperty("--accent", safeColor(track.author.accent));
}

function updatePlayerInfo(track) {
  $("#playerTitle").textContent = track.title;
  $("#playerAuthor").textContent = `@${track.author.username} · ${track.author.display_name}`;
  $("#playerCover").textContent = track.author.avatar || "🎵";
  setPlayerAccent(track);
  $("#playerDownload").href = `/api/tracks/${track.id}/download`;
  $("#playerDownload").setAttribute("download", "");
}

function showPlayer() {
  playerBar.classList.add("is-visible");
}

function hidePlayer() {
  playerBar.classList.remove("is-visible", "is-playing");
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.load();
  state.currentId = null;
  state.playing = false;
  $("#playerTitle").textContent = "Трек не выбран";
  $("#playerAuthor").textContent = "—";
  $("#playerCover").textContent = "🎵";
  $("#timeCurrent").textContent = "0:00";
  $("#timeTotal").textContent = "0:00";
  $("#seekBar").value = "0";
  setRangeFill($("#seekBar"), 0);
  syncPlaybackUI();
}

function countPlay(track) {
  if (state.playCounted.has(track.id)) return;
  state.playCounted.add(track.id);
  api(`/api/tracks/${track.id}/play`, { method: "POST" })
    .then((data) => {
      track.plays = data.plays;
      if (state.detail && state.detail.track.id === track.id) {
        state.detail.track.plays = data.plays;
      }
      updateTrackMeta(track);
    })
    .catch(() => {});
}

function togglePlay(track) {
  if (!track) return;
  if (state.currentId !== track.id) {
    state.currentId = track.id;
    audioEl.src = `/audio/${track.id}`;
    updatePlayerInfo(track);
    showPlayer();
    countPlay(track);
  } else {
    showPlayer();
  }
  if (audioEl.paused) {
    audioEl.play().catch(() => toast("Не удалось воспроизвести файл", "error"));
  } else {
    audioEl.pause();
  }
}

function setMixerLive(live) {
  if (mixerEl) mixerEl.classList.toggle("is-live", live);
  if (mixerStatus) mixerStatus.textContent = live ? "LIVE" : "STANDBY";
}

function syncPlaybackUI() {
  const playing = Boolean(state.currentId) && !audioEl.paused;
  state.playing = playing;

  $$(".track").forEach((card) => {
    const active = card.dataset.trackId === state.currentId && playing;
    card.classList.toggle("is-playing", active);
    $$("[data-play]", card).forEach((button) => {
      button.setAttribute("aria-label", active ? "Пауза" : "Слушать трек");
    });
  });

  const detail = $("#trackDetail");
  if (detail) {
    const active = detail.dataset.trackId === state.currentId && playing;
    detail.classList.toggle("is-playing", active);
    $$("[data-play]", detail).forEach((button) => {
      button.setAttribute("aria-label", active ? "Пауза" : "Слушать трек");
    });
  }

  playerBar.classList.toggle("is-playing", playing);
  $("#playPause").setAttribute("aria-label", playing ? "Пауза" : "Играть");
}

audioEl.addEventListener("play", () => {
  syncPlaybackUI();
  setMixerLive(true);
});
audioEl.addEventListener("pause", () => {
  syncPlaybackUI();
  setMixerLive(false);
});
audioEl.addEventListener("ended", () => {
  const index = state.tracks.findIndex((track) => track.id === state.currentId);
  const next = index >= 0 ? state.tracks[index + 1] : null;
  if (next) {
    togglePlay(next);
  } else {
    syncPlaybackUI();
    setMixerLive(false);
    $("#seekBar").value = "0";
    setRangeFill($("#seekBar"), 0);
    $("#timeCurrent").textContent = "0:00";
  }
});
audioEl.addEventListener("loadedmetadata", () => {
  $("#timeTotal").textContent = formatTime(audioEl.duration);
  $("#seekBar").value = "0";
  setRangeFill($("#seekBar"), 0);
});
audioEl.addEventListener("timeupdate", () => {
  if (!Number.isFinite(audioEl.duration) || audioEl.duration <= 0) return;
  const fraction = audioEl.currentTime / audioEl.duration;
  if (!state.seekDragging) {
    $("#seekBar").value = String(Math.round(fraction * 1000));
    setRangeFill($("#seekBar"), fraction * 100);
  }
  $("#timeCurrent").textContent = formatTime(audioEl.currentTime);
});
audioEl.addEventListener("error", () => {
  if (state.currentId) toast("Аудиофайл не загрузился", "error");
});

$("#seekBar").addEventListener("input", (event) => {
  if (!Number.isFinite(audioEl.duration) || audioEl.duration <= 0) return;
  const fraction = Number(event.target.value) / 1000;
  audioEl.currentTime = fraction * audioEl.duration;
  setRangeFill(event.target, fraction * 100);
  $("#timeCurrent").textContent = formatTime(fraction * audioEl.duration);
});
$("#seekBar").addEventListener("pointerdown", () => { state.seekDragging = true; });
window.addEventListener("pointerup", () => { state.seekDragging = false; });
$("#volumeBar").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  audioEl.volume = value / 100;
  setRangeFill(event.target, value);
});
$("#playPause").addEventListener("click", () => {
  if (!state.currentId) {
    const first = filteredTracks()[0];
    if (first) togglePlay(first);
    return;
  }
  if (audioEl.paused) audioEl.play().catch(() => toast("Не удалось воспроизвести файл", "error"));
  else audioEl.pause();
});
$("#playerClose").addEventListener("click", hidePlayer);
$("#playerAuthor").addEventListener("click", () => {
  const track = trackById(state.currentId);
  if (track) navigate(userPath(track.author.username));
});

/* ---------- Страница трека ---------- */

async function renderTrackRoute(trackId, seq) {
  const container = $("#trackDetail");
  container.dataset.trackId = trackId;
  container.innerHTML = pageLoader("Загружаю трек…");
  try {
    const data = await api(`/api/tracks/${trackId}`);
    if (seq !== state.routeSeq) return;
    state.detail = data;
    if (!state.tracks.some((track) => track.id === data.track.id)) {
      state.tracks.push(data.track);
    }
    renderTrackDetail(data);
    setPageMeta(
      `${data.track.title} — ${data.track.author.display_name} — Волна`,
      (data.track.description || `Слушайте «${data.track.title}» на Волне.`).slice(0, 180),
      "music.song"
    );
    if (location.hash === "#comments") {
      requestAnimationFrame(() => $("#comments")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
    syncPlaybackUI();
  } catch (error) {
    if (seq !== state.routeSeq) return;
    if (error.status === 404) showNotFound("Трек не найден или был удалён.");
    else {
      container.innerHTML = `<div class="not-found-inline"><h2>Не удалось загрузить трек</h2><p>${esc(error.message)}</p><a class="btn btn-ghost" href="/" data-link>Вернуться в ленту</a></div>`;
      toast(error.message, "error");
    }
  }
}

function detailCommentsHtml(data) {
  const track = data.track;
  const comments = data.comments || [];
  if (!comments.length) {
    return '<div class="comments-empty">Пока тихо. Будьте первым, кто оставит отзыв.</div>';
  }
  return comments.map((comment) => {
    const author = comment.author || {};
    return `
      <article class="comment" data-comment-id="${comment.id}">
        <a class="avatar avatar-sm" href="${userPath(author.username || "deleted")}" data-link>${esc(author.avatar || "👻")}</a>
        <div class="comment-main">
          <div class="comment-head">
            <a href="${userPath(author.username || "deleted")}" data-link>${esc(author.display_name || "Удалённый пользователь")}</a>
            <span class="comment-handle">@${esc(author.username || "deleted")}</span>
            <time datetime="${esc(comment.created_at)}" title="${esc(formatDateTime(comment.created_at))}">${esc(relativeTime(comment.created_at))}</time>
            ${comment.can_delete ? `<button class="comment-delete" type="button" data-comment-delete="${comment.id}" aria-label="Удалить комментарий">${ICON_TRASH}</button>` : ""}
          </div>
          <p>${esc(comment.text)}</p>
        </div>
      </article>`;
  }).join("");
}

function commentComposerHtml() {
  if (!state.user) {
    return `<div class="comment-login">
      <div><strong>Хотите высказаться?</strong><span>Войдите, чтобы оставить комментарий.</span></div>
      <button class="btn btn-primary btn-sm" type="button" data-login>Войти</button>
    </div>`;
  }
  return `<form class="comment-form" id="commentForm">
    <div class="avatar avatar-sm" style="--accent:${safeColor(state.user.accent)}">${esc(state.user.avatar || "🎵")}</div>
    <div class="comment-input-wrap">
      <textarea id="commentText" maxlength="1000" rows="3" placeholder="Поделитесь впечатлением о треке…" required></textarea>
      <div class="comment-form-foot">
        <span id="commentCounter">0/1000</span>
        <button class="btn btn-primary btn-sm" type="submit">Отправить</button>
      </div>
    </div>
  </form>`;
}

function renderTrackDetail(data) {
  const track = data.track;
  const accent = safeColor(track.author.accent);
  const author = track.author;
  const comments = data.comments || [];
  const related = data.related || [];
  const ownerActions = track.mine
    ? `<button class="btn btn-ghost btn-sm" type="button" data-edit="${track.id}">${ICON_EDIT} Редактировать</button>
       <button class="btn btn-ghost btn-sm danger-ghost" type="button" data-delete="${track.id}">${ICON_TRASH} Удалить</button>`
    : "";
  const relatedHtml = related.length
    ? `<section class="related-block">
         <div class="section-heading">
           <div><p class="eyebrow">Автор</p><h2>Ещё от автора</h2></div>
           <a class="section-link" href="${userPath(author.username)}" data-link>Все треки →</a>
         </div>
         <div class="track-grid">${related.map(trackCard).join("")}</div>
       </section>`
    : "";

  const container = $("#trackDetail");
  container.dataset.trackId = track.id;
  container.style.setProperty("--accent", accent);
  container.innerHTML = `
    <div class="detail-card">
      <div class="detail-cover">
        <div class="detail-cover-rings" aria-hidden="true"></div>
        <div class="detail-cover-emoji">${esc(author.avatar || "🎵")}</div>
        <div class="detail-cover-label">${esc(formatDate(track.created_at))} · ${esc((track.ext || "").replace(".", "").toUpperCase())}</div>
        <button class="detail-play-fab" type="button" data-play="${track.id}" aria-label="Слушать трек">
          ${ICON_PLAY}${ICON_PAUSE}
        </button>
        <div class="detail-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
      <div class="detail-body">
        <p class="eyebrow">Трек · ${esc(formatDate(track.created_at))}</p>
        <h1 class="detail-title">${esc(track.title)}</h1>
        <a class="detail-author" href="${userPath(author.username)}" data-link>
          <span class="avatar avatar-sm" style="--accent:${safeColor(author.accent)}">${esc(author.avatar || "🎵")}</span>
          <span>${esc(author.display_name)}</span>
          <small>@${esc(author.username)}</small>
        </a>
        <p class="detail-description">${esc(track.description || "Автор не добавил описание — просто включите и слушайте.")}</p>
        <div class="detail-stats">
          <div><strong data-detail-plays>${formatNumber(track.plays)}</strong><span>${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")}</span></div>
          <div><strong data-detail-likes>${formatNumber(track.likes)}</strong><span>${plural(track.likes, "лайк", "лайка", "лайков")}</span></div>
          <div><strong data-detail-comments>${formatNumber(track.comment_count)}</strong><span>${plural(track.comment_count, "комментарий", "комментария", "комментариев")}</span></div>
          <div><strong>${formatSize(track.size)}</strong><span>${esc((track.ext || "").replace(".", "").toUpperCase())}</span></div>
        </div>
        <div class="detail-actions">
          <button class="btn btn-primary detail-listen" type="button" data-play="${track.id}">
            ${ICON_PLAY}${ICON_PAUSE}<span class="label-play">Слушать</span><span class="label-pause">Пауза</span>
          </button>
          <a class="btn btn-ghost" href="/api/tracks/${track.id}/download" data-download="${track.id}" download>${ICON_DOWNLOAD} Скачать</a>
          <button class="like-btn${track.liked ? " is-liked" : ""}" type="button" data-like="${track.id}" aria-pressed="${track.liked}">
            <span class="like-icon">${track.liked ? ICON_HEART_FILLED : ICON_HEART}</span>
            <span data-like-count>${formatNumber(track.likes)}</span>
          </button>
          <button class="btn btn-ghost btn-sm" type="button" data-share="${track.id}">${ICON_SHARE} Поделиться</button>
          ${ownerActions}
        </div>
        <p class="detail-hint">Скачивание бесплатное · <code>/track/${track.id}</code></p>
      </div>
    </div>

    <section class="comments-block" id="comments">
      <div class="comments-heading">
        <div>
          <p class="eyebrow">Обсуждение</p>
          <h2>Комментарии <span class="comments-count" id="commentCount">${formatNumber(track.comment_count)}</span></h2>
        </div>
        <span class="comments-caption">${track.comment_count ? "Живое обсуждение трека" : "Начните разговор"}</span>
      </div>
      ${commentComposerHtml()}
      <div class="comments-list" id="commentsList">${detailCommentsHtml(data)}</div>
    </section>

    ${relatedHtml}`;
}

function updateDetailStats() {
  const detail = state.detail;
  if (!detail) return;
  const track = detail.track;
  $$("[data-detail-plays]").forEach((el) => { el.textContent = formatNumber(track.plays); });
  $$("[data-detail-likes]").forEach((el) => { el.textContent = formatNumber(track.likes); });
  $$("[data-detail-comments]").forEach((el) => { el.textContent = formatNumber(track.comment_count); });
  const count = $("#commentCount");
  if (count) count.textContent = formatNumber(track.comment_count);
}

function updateLikeUI(trackId, liked, likes) {
  $$(`[data-like="${trackId}"]`).forEach((button) => {
    button.classList.toggle("is-liked", liked);
    button.setAttribute("aria-pressed", String(liked));
    const icon = $(".like-icon", button);
    if (icon) icon.innerHTML = liked ? ICON_HEART_FILLED : ICON_HEART;
    const count = $("[data-like-count]", button);
    if (count) count.textContent = formatNumber(likes);
  });
  $$(`[data-likes-for="${trackId}"]`).forEach((el) => {
    el.innerHTML = `${ICON_HEART_SMALL}${formatNumber(likes)}`;
  });
  if (state.detail && state.detail.track.id === trackId) {
    state.detail.track.liked = liked;
    state.detail.track.likes = likes;
    updateDetailStats();
  }
}

async function toggleLike(trackId) {
  if (!state.user) {
    openAuth("login", location.pathname);
    return;
  }
  try {
    const data = await api(`/api/tracks/${trackId}/like`, { method: "POST" });
    const track = trackById(trackId);
    if (track) {
      track.liked = data.liked;
      track.likes = data.likes;
    }
    updateLikeUI(trackId, data.liked, data.likes);
    toast(data.liked ? "Добавлено в понравившиеся" : "Убрано из понравившихся");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  }
}

function updateCommentUI() {
  if (!state.detail) return;
  const count = state.detail.comments.length;
  state.detail.track.comment_count = count;
  const mainTrack = state.tracks.find((track) => track.id === state.detail.track.id);
  if (mainTrack) mainTrack.comment_count = count;
  const list = $("#commentsList");
  if (list) list.innerHTML = detailCommentsHtml(state.detail);
  $$(`[data-comments-for="${state.detail.track.id}"]`).forEach((el) => {
    el.innerHTML = `${ICON_COMMENT_SMALL}${formatNumber(count)}`;
  });
  updateDetailStats();
}

async function submitComment(event, form) {
  event.preventDefault();
  if (!state.detail) return;
  if (!state.user) {
    openAuth("login", location.pathname);
    return;
  }
  const textarea = $("#commentText");
  const text = textarea.value.trim();
  if (!text) {
    toast("Напишите комментарий", "error");
    textarea.focus();
    return;
  }
  const button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    const data = await api(`/api/tracks/${state.detail.track.id}/comments`, {
      method: "POST",
      body: { text },
    });
    state.detail.comments.unshift(data.comment);
    textarea.value = "";
    $("#commentCounter").textContent = "0/1000";
    updateCommentUI();
    toast("Комментарий добавлен", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function deleteComment(commentId, silent = false) {
  if (!silent && !window.confirm("Удалить этот комментарий?")) return;
  try {
    const data = await api(`/api/comments/${commentId}`, { method: "DELETE" });
    if (state.detail) {
      state.detail.comments = state.detail.comments.filter((comment) => comment.id !== commentId);
      updateCommentUI();
    }
    const row = $(`[data-activity-comment="${commentId}"]`);
    if (row) row.remove();
    if (state.route.name === "account") {
      await loadMe().catch(() => {});
      renderAccount();
    }
    toast("Комментарий удалён");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  }
}

async function shareTrack(trackId) {
  const url = `${location.origin}${trackPath(trackId)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Ссылка на трек скопирована", "success");
  } catch (error) {
    window.prompt("Скопируйте ссылку на трек:", url);
  }
}

/* ---------- Профиль автора ---------- */

async function renderUserRoute(username, seq) {
  const container = $("#userProfile");
  container.innerHTML = pageLoader("Загружаю профиль…");
  try {
    const data = await api(`/api/users/${encodeUsername(username)}`);
    if (seq !== state.routeSeq) return;
    state.profile = data;
    renderUserProfile(data);
    setPageMeta(
      `${data.user.display_name} (@${data.user.username}) — Волна`,
      (data.user.bio || `Профиль @${data.user.username} на Волне.`).slice(0, 180),
      "profile"
    );
    syncPlaybackUI();
  } catch (error) {
    if (seq !== state.routeSeq) return;
    if (error.status === 404) showNotFound("Автор не найден.");
    else {
      container.innerHTML = `<div class="not-found-inline"><h2>Не удалось загрузить профиль</h2><p>${esc(error.message)}</p><a class="btn btn-ghost" href="/" data-link>Вернуться в ленту</a></div>`;
      toast(error.message, "error");
    }
  }
}

function renderUserProfile(data) {
  const user = data.user;
  const stats = user.stats || {};
  const tracks = data.tracks || [];
  const accent = safeColor(user.accent);
  const actions = user.is_self
    ? `<a class="btn btn-ghost" href="/account" data-link>Настройки профиля</a>`
    : `<button class="btn btn-ghost" type="button" data-play-first="${tracks[0] ? tracks[0].id : ""}" ${tracks.length ? "" : "disabled"}>Слушать автора</button>`;
  const tracksHtml = tracks.length
    ? `<div class="track-grid">${tracks.map(trackCard).join("")}</div>`
    : `<div class="empty-state profile-empty"><div class="empty-icon">🎙</div><h3>Пока без треков</h3><p>Автор ещё не опубликовал ни одного звука.</p></div>`;

  $("#userProfile").innerHTML = `
    <div class="profile-hero" style="--accent:${accent}">
      <div class="profile-hero-glow" aria-hidden="true"></div>
      <div class="avatar avatar-xxl profile-avatar">${esc(user.avatar || "🎵")}</div>
      <div class="profile-hero-main">
        <p class="eyebrow">Автор на Волне</p>
        <h1>${esc(user.display_name)} <span>@${esc(user.username)}</span></h1>
        <p class="profile-bio">${esc(user.bio || "Автор пока не рассказал о себе.")}</p>
        <p class="profile-joined">На Волне с ${esc(formatDate(user.created_at))}</p>
        <div class="profile-actions">${actions}</div>
      </div>
      <div class="profile-hero-stats">
        <div><strong>${formatNumber(stats.tracks || 0)}</strong><span>треков</span></div>
        <div><strong>${formatNumber(stats.plays || 0)}</strong><span>прослушиваний</span></div>
        <div><strong>${formatNumber(stats.likes || 0)}</strong><span>лайков</span></div>
        <div><strong>${formatNumber(stats.comments || 0)}</strong><span>комментариев</span></div>
      </div>
    </div>
    <div class="section-heading profile-tracks-heading">
      <div><p class="eyebrow">Дискография</p><h2>Треки автора</h2></div>
      <span class="section-count">${formatNumber(tracks.length)} ${plural(tracks.length, "трек", "трека", "треков")}</span>
    </div>
    ${tracksHtml}`;
}

/* ---------- Загрузка ---------- */

function renderUploadState() {
  const hasFile = Boolean(state.uploadFile);
  $("#dropzoneEmpty").hidden = hasFile;
  $("#dropzoneFile").hidden = !hasFile;
  if (hasFile) {
    $("#fileName").textContent = state.uploadFile.name;
    $("#fileSize").textContent = formatSize(state.uploadFile.size);
  }
}

function acceptFile(file) {
  if (!file) return;
  const name = file.name || "audio";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXT.includes(ext)) {
    toast("Этот формат не поддерживается. Загрузите MP3, WAV, OGG, M4A, FLAC или WEBM.", "error");
    return;
  }
  if (file.size > MAX_UPLOAD) {
    toast("Файл больше 80 МБ", "error");
    return;
  }
  if (file.size === 0) {
    toast("Файл пустой", "error");
    return;
  }
  state.uploadFile = file;
  renderUploadState();
  if (!$("#uploadTitle").value.trim()) {
    const base = name.slice(0, dot >= 0 ? dot : name.length).replace(/[_-]+/g, " ").trim();
    $("#uploadTitle").value = base.slice(0, 120);
    updateTitleCounter();
  }
}

function updateTitleCounter() {
  const counter = $("#titleCount");
  if (counter) counter.textContent = String($("#uploadTitle").value.length);
}

function resetUploadUI() {
  state.uploadFile = null;
  $("#fileInput").value = "";
  renderUploadState();
  updateTitleCounter();
  $("#uploadProgress").hidden = true;
  $("#progressBar").style.width = "0%";
  $("#progressLabel").textContent = "0%";
  $("#uploadSubmit").disabled = false;
}

async function handleUpload(event) {
  event.preventDefault();
  if (!state.user) {
    openAuth("login", "/upload");
    return;
  }
  const title = $("#uploadTitle").value.trim();
  const description = $("#uploadDescription").value.trim();
  if (!state.uploadFile) {
    toast("Выберите аудиофайл", "error");
    $("#dropzone").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (!title) {
    toast("Придумайте название трека", "error");
    $("#uploadTitle").focus();
    return;
  }

  const formData = new FormData();
  formData.append("title", title);
  formData.append("description", description);
  formData.append("file", state.uploadFile, state.uploadFile.name);

  const submit = $("#uploadSubmit");
  submit.disabled = true;
  $("#uploadProgress").hidden = false;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/tracks");
  xhr.withCredentials = true;
  xhr.upload.addEventListener("progress", (progressEvent) => {
    if (!progressEvent.lengthComputable) return;
    const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
    $("#progressBar").style.width = `${percent}%`;
    $("#progressLabel").textContent = `${percent}%`;
  });
  xhr.addEventListener("load", async () => {
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch (error) { data = null; }
    if (xhr.status >= 200 && xhr.status < 300) {
      $("#uploadProgress").hidden = true;
      $("#uploadForm").reset();
      resetUploadUI();
      await ensureTracks(true);
      await loadMe().catch(() => {});
      navigate(trackPath(data.track.id));
      toast("Трек опубликован — можно слушать", "success");
    } else {
      submit.disabled = false;
      $("#uploadProgress").hidden = true;
      if (xhr.status === 401) {
        state.user = null;
        renderAuthArea();
        openAuth("login", "/upload");
      }
      toast((data && data.error) || `Не удалось загрузить файл (${xhr.status})`, "error");
    }
  });
  xhr.addEventListener("error", () => {
    submit.disabled = false;
    $("#uploadProgress").hidden = true;
    toast("Сервер недоступен. Проверьте соединение.", "error");
  });
  xhr.send(formData);
}

function bindDropzone() {
  const dropzone = $("#dropzone");
  const input = $("#fileInput");
  input.addEventListener("change", () => {
    if (input.files && input.files[0]) acceptFile(input.files[0]);
  });
  ["dragenter", "dragover"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.remove("is-dragover");
    });
  });
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) acceptFile(file);
  });
  $("#uploadForm").addEventListener("reset", () => setTimeout(resetUploadUI, 0));
}

/* ---------- Кабинет ---------- */

function renderAccount() {
  const user = state.user;
  if (!user) return;

  avatarElement("accountAvatar", user);
  avatarElement("avatarPreview", user);
  $("#accountDisplayName").textContent = user.display_name || user.username;
  $("#accountUsername").textContent = `@${user.username}`;
  $("#accountBio").textContent = user.bio || "Пока без описания — расскажите о себе в настройках.";
  $("#accountTracks").textContent = formatNumber(user.tracks_count || 0);
  $("#accountPlays").textContent = formatNumber(user.plays_total || 0);
  $("#accountLikes").textContent = formatNumber(user.likes_received || 0);
  $("#accountComments").textContent = formatNumber(user.comments_received || 0);
  $("#accountTracksLabel").textContent = plural(user.tracks_count || 0, "трек", "трека", "треков");
  $("#accountPlaysLabel").textContent = plural(user.plays_total || 0, "прослушивание", "прослушивания", "прослушиваний");
  $("#accountLikesLabel").textContent = plural(user.likes_received || 0, "лайк", "лайка", "лайков");
  $("#accountCommentsLabel").textContent = plural(user.comments_received || 0, "комментарий", "комментария", "комментариев");
  $("#accountDownloadsLine").textContent = `Скачиваний: ${formatNumber(user.downloads_total || 0)} · поставлено лайков: ${formatNumber(user.likes_given || 0)} · написано комментариев: ${formatNumber(user.comments_written || 0)}`;
  $("#accountJoined").textContent = user.created_at ? `С нами с ${formatDate(user.created_at)}` : "";
  $("#publicProfileLink").href = userPath(user.username);
  $("#sessionExpires").textContent = state.session ? formatDateTime(state.session.expires_at) : "—";
  $("#lastLoginLine").textContent = user.last_login_at ? `Последний вход: ${formatDateTime(user.last_login_at)}` : "";

  $("#settingsAvatar").value = user.avatar || "🎵";
  $("#settingsDisplayName").value = user.display_name || "";
  $("#settingsBio").value = user.bio || "";
  $("#settingsAccent").value = safeColor(user.accent);
  $("#accentValue").textContent = safeColor(user.accent);
  $("#avatarPreview").textContent = user.avatar || "🎵";
  $("#avatarPreview").style.setProperty("--accent", safeColor(user.accent));
  $("#settingsUsername").value = user.username;
  $("#settingsEmail").value = user.email || "";
  $("#accountCurrentPassword").value = "";
  $("#passwordCurrent").value = "";
  $("#passwordNew").value = "";
  $("#passwordRepeat").value = "";
  $("#deletePassword").value = "";

  renderMyTracks();
  loadAccountExtras();
}

function renderMyTracks() {
  const container = $("#myTracks");
  if (!container) return;
  const mine = state.tracks.filter((track) => track.mine);
  if (!mine.length) {
    container.innerHTML = '<div class="empty-inline">Вы ещё не загрузили ни одного трека. <a href="/upload" data-link>Загрузить →</a></div>';
    return;
  }
  container.innerHTML = mine.map((track) => `
    <div class="my-track">
      <div class="my-track-cover" style="--accent:${safeColor(track.author.accent)}">${esc(track.author.avatar || "🎵")}</div>
      <div class="my-track-info">
        <a class="my-track-title" href="${trackPath(track.id)}" data-link>${esc(track.title)}</a>
        <div class="my-track-meta">${formatSize(track.size)} · ${formatNumber(track.plays)} прослушиваний · ${formatDate(track.created_at)}</div>
      </div>
      <div class="my-track-actions">
        <button class="icon-action" type="button" data-play="${track.id}" title="Слушать" aria-label="Слушать">${ICON_PLAY}</button>
        <button class="icon-action" type="button" data-edit="${track.id}" title="Редактировать" aria-label="Редактировать">${ICON_EDIT}</button>
        <button class="icon-action danger" type="button" data-delete="${track.id}" title="Удалить" aria-label="Удалить">${ICON_TRASH}</button>
      </div>
    </div>`).join("");
}

async function loadAccountExtras() {
  if (!state.user) return;
  const userId = state.user.id;
  try {
    const [likes, comments] = await Promise.all([
      api("/api/me/likes"),
      api("/api/me/comments"),
    ]);
    if (!state.user || state.user.id !== userId || state.route.name !== "account") return;
    renderLikedTracks(likes.tracks || []);
    renderMyComments(comments.comments || []);
  } catch (error) {
    const liked = $("#likedTracks");
    const myComments = $("#myComments");
    if (liked) liked.innerHTML = '<div class="empty-inline">Не удалось загрузить лайки.</div>';
    if (myComments) myComments.innerHTML = '<div class="empty-inline">Не удалось загрузить комментарии.</div>';
  }
}

function renderLikedTracks(tracks) {
  const container = $("#likedTracks");
  if (!container) return;
  if (!tracks.length) {
    container.innerHTML = '<div class="empty-inline">Пока нет понравившихся треков. Отмечайте ♥ на странице трека.</div>';
    return;
  }
  container.innerHTML = tracks.map((track) => `
    <a class="activity-track" href="${trackPath(track.id)}" data-link>
      <span class="activity-cover" style="--accent:${safeColor(track.author.accent)}">${esc(track.author.avatar || "🎵")}</span>
      <span class="activity-track-main">
        <strong>${esc(track.title)}</strong>
        <small>@${esc(track.author.username)} · ${formatSize(track.size)} · ${formatNumber(track.plays)} ${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")}</small>
      </span>
      <span class="activity-like">${ICON_HEART_FILLED}</span>
    </a>`).join("");
}

function renderMyComments(comments) {
  const container = $("#myComments");
  if (!container) return;
  if (!comments.length) {
    container.innerHTML = '<div class="empty-inline">Вы пока не оставляли комментариев.</div>';
    return;
  }
  container.innerHTML = comments.map((comment) => `
    <div class="activity-comment" data-activity-comment="${comment.id}">
      <p>${esc(comment.text)}</p>
      <div class="activity-comment-meta">
        <span>${esc(relativeTime(comment.created_at))}</span>
        <span class="dot">·</span>
        <a href="${trackPath(comment.track.id)}" data-link>${esc(comment.track.title)}</a>
        <button class="comment-delete" type="button" data-comment-delete="${comment.id}" aria-label="Удалить комментарий">${ICON_TRASH}</button>
      </div>
    </div>`).join("");
}

async function saveProfile(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  try {
    const data = await api("/api/account", {
      method: "PATCH",
      body: {
        avatar: $("#settingsAvatar").value.trim() || "🎵",
        display_name: $("#settingsDisplayName").value.trim(),
        bio: $("#settingsBio").value.trim(),
        accent: $("#settingsAccent").value,
      },
    });
    state.user = data.user;
    state.session = data.session || state.session;
    renderAuthArea();
    renderAccount();
    await ensureTracks(true);
    toast("Профиль сохранён", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function saveAccount(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  const password = $("#accountCurrentPassword").value;
  const username = $("#settingsUsername").value.trim();
  const usernameChanged = username !== state.user.username;
  if (!username) {
    toast("Имя пользователя не может быть пустым", "error");
    $("#settingsUsername").focus();
    return;
  }
  if (usernameChanged && !password) {
    toast("Для смены имени введите текущий пароль", "error");
    $("#accountCurrentPassword").focus();
    return;
  }
  button.disabled = true;
  try {
    const body = { username, email: $("#settingsEmail").value.trim() };
    if (password) body.current_password = password;
    const data = await api("/api/account", { method: "PATCH", body });
    state.user = data.user;
    state.session = data.session || state.session;
    renderAuthArea();
    renderAccount();
    await ensureTracks(true);
    toast("Данные аккаунта обновлены", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function savePassword(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  const current = $("#passwordCurrent").value;
  const next = $("#passwordNew").value;
  const repeat = $("#passwordRepeat").value;
  if (next !== repeat) {
    toast("Новые пароли не совпадают", "error");
    return;
  }
  if (next.length < 6) {
    toast("Новый пароль должен содержать минимум 6 символов", "error");
    return;
  }
  button.disabled = true;
  try {
    const data = await api("/api/account", {
      method: "PATCH",
      body: { current_password: current, new_password: next },
    });
    state.user = data.user;
    state.session = data.session || state.session;
    $("#passwordCurrent").value = "";
    $("#passwordNew").value = "";
    $("#passwordRepeat").value = "";
    renderAccount();
    toast("Пароль изменён. Остальные сеансы завершены.", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function logoutAll() {
  const button = $("#logoutAllBtn");
  button.disabled = true;
  try {
    const data = await api("/api/account/logout-all", { method: "POST" });
    state.session = data.session;
    $("#sessionExpires").textContent = state.session ? formatDateTime(state.session.expires_at) : "—";
    toast("Все другие сеансы завершены", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function deleteAccount(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  const password = $("#deletePassword").value;
  if (!password) {
    toast("Введите пароль для подтверждения", "error");
    return;
  }
  if (!window.confirm("Удалить аккаунт и все ваши треки? Это действие необратимо.")) return;
  button.disabled = true;
  try {
    await api("/api/account/delete", { method: "POST", body: { password } });
    state.user = null;
    state.session = null;
    renderAuthArea();
    $("#deleteForm").reset();
    await ensureTracks(true);
    navigate("/", { replace: true });
    toast("Аккаунт удалён", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
    button.disabled = false;
  }
}

/* ---------- Редактирование трека ---------- */

function openEdit(trackId) {
  const track = trackById(trackId);
  if (!track || !track.mine) return;
  state.editingId = trackId;
  $("#editTrackTitle").value = track.title;
  $("#editTrackDescription").value = track.description || "";
  $("#editModal").hidden = false;
  syncBodyLock();
  setTimeout(() => $("#editTrackTitle").focus(), 60);
}

function closeEdit() {
  $("#editModal").hidden = true;
  state.editingId = null;
  syncBodyLock();
}

async function saveEdit(event) {
  event.preventDefault();
  if (!state.editingId) return;
  const button = $("button[type=submit]", event.currentTarget);
  const title = $("#editTrackTitle").value.trim();
  if (!title) {
    toast("Название не может быть пустым", "error");
    return;
  }
  button.disabled = true;
  try {
    const data = await api(`/api/tracks/${state.editingId}`, {
      method: "PATCH",
      body: { title, description: $("#editTrackDescription").value.trim() },
    });
    const index = state.tracks.findIndex((track) => track.id === state.editingId);
    if (index >= 0) state.tracks[index] = data.track;
    if (state.detail && state.detail.track.id === data.track.id) {
      state.detail.track.title = data.track.title;
      state.detail.track.description = data.track.description;
    }
    if (state.currentId === data.track.id) updatePlayerInfo(data.track);
    closeEdit();
    if (state.route.name === "track" && state.route.id === data.track.id) {
      await renderRoute({ scroll: false });
    } else if (state.route.name === "user") {
      await renderRoute({ scroll: false });
    } else {
      renderTracks();
      renderMyTracks();
    }
    toast("Трек обновлён", "success");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function deleteTrack(trackId) {
  const track = trackById(trackId);
  if (!track) return;
  if (!window.confirm(`Удалить трек «${track.title}»? Файл будет удалён с сервера.`)) return;
  try {
    await api(`/api/tracks/${trackId}`, { method: "DELETE" });
    if (state.currentId === trackId) hidePlayer();
    state.tracks = state.tracks.filter((item) => item.id !== trackId);
    if (state.detail && state.detail.track.id === trackId) state.detail = null;
    if (state.route.name === "track" && state.route.id === trackId) {
      navigate("/", { replace: true });
    } else if (state.route.name === "user") {
      await renderRoute({ scroll: false });
    } else {
      renderTracks();
      updateStats();
      if (state.user) {
        await loadMe().catch(() => {});
        renderAccount();
      }
    }
    toast("Трек удалён");
  } catch (error) {
    if (!handleAuthFailure(error)) toast(error.message, "error");
  }
}

/* ---------- События ---------- */

function bindEvents() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-link]");
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey
        && !event.shiftKey && !event.altKey) {
      const href = link.getAttribute("href");
      if (href && !href.startsWith("http") && !link.hasAttribute("download")) {
        event.preventDefault();
        navigate(href);
        return;
      }
    }

    const actionButton = event.target.closest("[data-action]");
    if (actionButton && actionButton.dataset.action === "go-upload") {
      navigate("/upload");
      return;
    }

    const playButton = event.target.closest("[data-play]");
    if (playButton) {
      const track = trackById(playButton.dataset.play);
      if (track) togglePlay(track);
      return;
    }

    const firstPlay = event.target.closest("[data-play-first]");
    if (firstPlay) {
      const track = trackById(firstPlay.dataset.playFirst);
      if (track) togglePlay(track);
      return;
    }

    const likeButton = event.target.closest("[data-like]");
    if (likeButton) {
      toggleLike(likeButton.dataset.like);
      return;
    }

    const shareButton = event.target.closest("[data-share]");
    if (shareButton) {
      shareTrack(shareButton.dataset.share);
      return;
    }

    const loginButton = event.target.closest("[data-login]");
    if (loginButton) {
      openAuth("login", location.pathname);
      return;
    }

    const commentDelete = event.target.closest("[data-comment-delete]");
    if (commentDelete) {
      deleteComment(commentDelete.dataset.commentDelete);
      return;
    }

    const editButton = event.target.closest("[data-edit]");
    if (editButton) {
      openEdit(editButton.dataset.edit);
      return;
    }

    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) {
      deleteTrack(deleteButton.dataset.delete);
      return;
    }

    const downloadLink = event.target.closest("[data-download]");
    if (downloadLink) {
      const track = trackById(downloadLink.dataset.download);
      if (track) {
        toast("Скачивание началось — файл сохранится в загрузки", "success");
        setTimeout(() => {
          track.downloads = (track.downloads || 0) + 1;
          if (state.detail && state.detail.track.id === track.id) {
            state.detail.track.downloads = track.downloads;
          }
        }, 900);
      }
    }
  });

  $("#authArea").addEventListener("click", (event) => {
    if (event.target.closest("#loginOpen")) openAuth("login");
    if (event.target.closest("#headerLogout")) logout();
  });

  let searchTimer = null;
  $("#searchInput").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.query = value.trim();
      if (state.route.name !== "home") navigate("/");
      else renderTracks();
    }, 140);
  });

  $("#heroListen").addEventListener("click", () => {
    const first = filteredTracks()[0];
    if (first) togglePlay(first);
    else toast("В ленте пока нет треков");
  });

  $$("[data-close-auth]").forEach((el) => el.addEventListener("click", closeAuth));
  $$("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => switchAuthTab(button.dataset.authTab));
  });
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#registerForm").addEventListener("submit", handleRegister);
  $$("[data-close-edit]").forEach((el) => el.addEventListener("click", closeEdit));
  $("#editForm").addEventListener("submit", saveEdit);

  document.addEventListener("submit", (event) => {
    if (event.target.id === "commentForm") submitComment(event, event.target);
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "commentText") {
      const counter = $("#commentCounter");
      if (counter) counter.textContent = `${event.target.value.length}/1000`;
    }
  });

  bindDropzone();
  $("#uploadForm").addEventListener("submit", handleUpload);
  $("#uploadTitle").addEventListener("input", updateTitleCounter);

  $("#profileForm").addEventListener("submit", saveProfile);
  $("#accountForm").addEventListener("submit", saveAccount);
  $("#passwordForm").addEventListener("submit", savePassword);
  $("#deleteForm").addEventListener("submit", deleteAccount);
  $("#logoutBtn").addEventListener("click", logout);
  $("#logoutAllBtn").addEventListener("click", logoutAll);

  $("#settingsAvatar").addEventListener("input", (event) => {
    $("#avatarPreview").textContent = event.target.value.trim() || "🎵";
  });
  $("#settingsAccent").addEventListener("input", (event) => {
    const color = safeColor(event.target.value);
    $("#accentValue").textContent = color;
    $("#avatarPreview").style.setProperty("--accent", color);
  });
  $("#accentSwatches").addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-color]");
    if (!swatch) return;
    $("#settingsAccent").value = swatch.dataset.color;
    $("#settingsAccent").dispatchEvent(new Event("input"));
  });
  $("#emojiQuick").addEventListener("click", (event) => {
    const button = event.target.closest("[data-emoji]");
    if (!button) return;
    $("#settingsAvatar").value = button.dataset.emoji;
    $("#settingsAvatar").dispatchEvent(new Event("input"));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#editModal").hidden) closeEdit();
      else if (!$("#authModal").hidden) closeAuth();
      return;
    }
    if (event.code === "Space" && playerBar.classList.contains("is-visible")) {
      const tag = (event.target.tagName || "").toLowerCase();
      if (["input", "textarea", "select", "button", "a"].includes(tag)) return;
      event.preventDefault();
      if (audioEl.paused) audioEl.play().catch(() => {});
      else audioEl.pause();
    }
  });

  window.addEventListener("popstate", () => renderRoute());
}

/* ---------- Старт ---------- */

function normalizeLegacyUrl() {
  const hash = location.hash;
  if (hash === "#home" || hash === "#upload" || hash === "#account") {
    const path = hash === "#home" ? "/" : `/${hash.slice(1)}`;
    history.replaceState({}, "", path);
  } else if (hash.startsWith("#/")) {
    history.replaceState({}, "", hash.slice(1));
  }
  if (location.pathname.endsWith("/index.html")) {
    history.replaceState({}, "", "/");
  }
}

async function init() {
  normalizeLegacyUrl();
  bindEvents();
  setRangeFill($("#volumeBar"), 100);
  setRangeFill($("#seekBar"), 0);

  try {
    await loadMe();
  } catch (error) {
    toast(error.message, "error");
  }
  await ensureTracks(true);

  await renderRoute({ scroll: false });
}

document.addEventListener("DOMContentLoaded", init);
