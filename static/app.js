/* ============================================================
   Волна — клиентская логика
   ============================================================ */

"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  user: null,
  tracks: [],
  view: "home",
  query: "",
  author: "",
  currentId: null,
  playing: false,
  uploadFile: null,
  editingId: null,
  playCounted: new Set(),
  pendingView: null,
  seekDragging: false,
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
  if (size < 1024 * 1024) return `${(size / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} КБ`;
  return `${(size / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateFmt.format(date);
}

function formatNumber(value) {
  return numberFmt.format(Number(value) || 0);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function setRangeFill(input, percent) {
  input.style.setProperty("--fill", `${Math.max(0, Math.min(100, percent))}%`);
}

function trackById(id) {
  return state.tracks.find((track) => track.id === id) || null;
}

function avatarElement(id, user) {
  const el = $("#" + id);
  if (!el) return;
  el.textContent = user.avatar || "🎵";
  el.style.setProperty("--accent", safeColor(user.accent));
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

/* ---------- Навигация ---------- */

function setView(name, options = {}) {
  if (!["home", "upload", "account"].includes(name)) name = "home";

  if ((name === "upload" || name === "account") && !state.user) {
    openAuth("login", name);
    return;
  }

  state.view = name;
  $$(".view").forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  $$(".nav-link[data-view-link]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.viewLink === name);
  });

  if (name === "account") renderAccount();
  if (name === "upload") {
    renderUploadState();
    updateTitleCounter();
  }

  if (!options.noHash) history.replaceState(null, "", `#${name}`);
  document.title = {
    home: "Волна — аудио без границ",
    upload: "Загрузить трек — Волна",
    account: "Настройки аккаунта — Волна",
  }[name];

  if (!options.noScroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Авторизация ---------- */

function renderAuthArea() {
  const area = $("#authArea");
  if (state.user) {
    const user = state.user;
    area.innerHTML = `
      <button class="user-chip" id="userChip" type="button" title="Настройки аккаунта">
        <span class="avatar avatar-sm" style="--accent:${safeColor(user.accent)}">${esc(user.avatar || "🎵")}</span>
        <span class="handle-mini">@${esc(user.username)}</span>
      </button>
      <button class="icon-action" id="headerLogout" type="button" title="Выйти" aria-label="Выйти">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M10 12h10m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
  } else {
    area.innerHTML = '<button class="btn btn-ghost btn-sm" id="loginOpen" type="button">Войти</button>';
  }
}

function openAuth(tab = "login", view = null) {
  if (view) state.pendingView = view;
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
  state.pendingView = null;
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
    ? "Войдите, чтобы загружать треки и настраивать профиль."
    : "Минута — и вы сможете делиться своими звуками.";
}

function syncBodyLock() {
  const locked = !$("#authModal").hidden || !$("#editModal").hidden;
  document.body.classList.toggle("modal-open", locked);
}

function afterAuth(user, greeting) {
  const target = state.pendingView;
  state.pendingView = null;
  state.user = user;
  $("#authModal").hidden = true;
  syncBodyLock();
  renderAuthArea();
  renderAccount();
  loadTracks().catch(() => {});
  if (target) setView(target);
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
    afterAuth(data.user, `С возвращением, ${data.user.display_name}!`);
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
    afterAuth(data.user, `Аккаунт создан. Добро пожаловать, ${data.user.display_name}!`);
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
    /* Локальная сессия всё равно сбрасывается ниже. */
  }
  state.user = null;
  renderAuthArea();
  if (state.view === "upload" || state.view === "account") setView("home");
  await loadTracks();
  toast("Вы вышли из аккаунта");
}

/* ---------- Данные ---------- */

async function loadMe() {
  const data = await api("/api/me");
  state.user = data.user;
  renderAuthArea();
  if (state.view === "account") renderAccount();
}

async function loadTracks() {
  const data = await api("/api/tracks");
  state.tracks = data.tracks;
  renderTracks();
  updateStats();
  if (state.view === "account") renderAccount();
}

/* ---------- Лента ---------- */

function filteredTracks() {
  let list = state.tracks;
  if (state.author) {
    const target = state.author.toLowerCase();
    list = list.filter((track) => track.author.username.toLowerCase() === target);
  }
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((track) =>
      track.title.toLowerCase().includes(q) ||
      (track.description || "").toLowerCase().includes(q) ||
      track.author.username.toLowerCase().includes(q) ||
      track.author.display_name.toLowerCase().includes(q)
    );
  }
  return list;
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
    <article class="track${playing ? " is-playing" : ""}" data-track-id="${track.id}" style="--accent:${accent}" data-card-accent>
      <div class="cover">
        <span class="cover-emoji">${esc(track.author.avatar || "🎵")}</span>
        <div class="cover-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <button class="play-fab" type="button" data-play="${track.id}" aria-label="Слушать трек">
          ${ICON_PLAY}${ICON_PAUSE}
        </button>
      </div>
      <div class="track-body">
        <h3 class="track-title" title="${esc(track.title)}">${esc(track.title)}</h3>
        <button class="author-btn" type="button" data-author="${esc(track.author.username)}" title="Показать треки автора">
          <span class="mini-avatar">${esc(track.author.avatar || "🎵")}</span>
          <span>${esc(track.author.display_name)}</span>
        </button>
        ${description}
        <div class="track-meta">
          <span>${formatSize(track.size)}</span>
          <span class="dot">·</span>
          <span class="plays" data-plays-for="${track.id}">${formatNumber(track.plays)} ${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")}</span>
          <span class="dot downloads-dot">·</span>
          <span class="downloads" data-downloads-for="${track.id}">${formatNumber(track.downloads)} ${plural(track.downloads, "скачивание", "скачивания", "скачиваний")}</span>
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

function renderTracks() {
  const grid = $("#trackGrid");
  const empty = $("#emptyState");
  const list = filteredTracks();

  grid.innerHTML = list.map(trackCard).join("");
  grid.hidden = list.length === 0;
  empty.hidden = list.length > 0;

  const hasFilters = Boolean(state.query || state.author);
  if (list.length === 0) {
    $("#emptyTitle").textContent = hasFilters ? "Ничего не нашлось" : "Пока тихо";
    $("#emptyText").textContent = hasFilters
      ? "Попробуйте изменить запрос или сбросить фильтр автора."
      : "Здесь появятся треки — станьте первым, кто поделится звуком.";
  }

  if (hasFilters) {
    $("#feedSubtitle").textContent = `Найдено: ${formatNumber(list.length)} ${plural(list.length, "трек", "трека", "треков")}`;
  } else {
    $("#feedSubtitle").textContent = state.tracks.length
      ? `Свежие загрузки сообщества · ${formatNumber(state.tracks.length)} ${plural(state.tracks.length, "трек", "трека", "треков")}`
      : "Свежие загрузки сообщества";
  }

  const filterRow = $("#filterRow");
  if (state.author) {
    const sample = state.tracks.find((track) => track.author.username.toLowerCase() === state.author.toLowerCase());
    $("#authorFilterName").textContent = sample ? `@${sample.author.username}` : `@${state.author}`;
    filterRow.hidden = false;
  } else {
    filterRow.hidden = true;
  }

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
  const plays = $(`[data-plays-for="${track.id}"]`);
  if (plays) {
    plays.textContent = `${formatNumber(track.plays)} ${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")}`;
  }
  const downloads = $(`[data-downloads-for="${track.id}"]`);
  if (downloads) {
    downloads.textContent = `${formatNumber(track.downloads)} ${plural(track.downloads, "скачивание", "скачивания", "скачиваний")}`;
  }
  updateStats();
}

function setAuthorFilter(username) {
  state.author = username;
  state.query = "";
  $("#searchInput").value = "";
  renderTracks();
  const feed = $(".feed");
  if (feed) feed.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearAuthorFilter() {
  state.author = "";
  renderTracks();
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
    audioEl.play().catch(() => {
      toast("Не удалось воспроизвести файл", "error");
    });
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
  if (audioEl.paused) {
    audioEl.play().catch(() => toast("Не удалось воспроизвести файл", "error"));
  } else {
    audioEl.pause();
  }
});

$("#playerClose").addEventListener("click", hidePlayer);

$("#playerAuthor").addEventListener("click", () => {
  const track = trackById(state.currentId);
  if (track) setAuthorFilter(track.author.username);
});

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
    openAuth("login", "upload");
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
      await loadTracks();
      await loadMe().catch(() => {});
      setView("home");
      toast("Трек опубликован — он уже в ленте", "success");
      const firstCard = $(".track");
      if (firstCard) firstCard.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      submit.disabled = false;
      $("#uploadProgress").hidden = true;
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

  $("#uploadForm").addEventListener("reset", () => {
    setTimeout(resetUploadUI, 0);
  });
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
  const accountTracks = user.tracks_count || 0;
  const accountPlays = user.plays_total || 0;
  const accountDownloads = user.downloads_total || 0;
  $("#accountTracks").textContent = formatNumber(accountTracks);
  $("#accountPlays").textContent = formatNumber(accountPlays);
  $("#accountDownloads").textContent = formatNumber(accountDownloads);
  $("#accountTracksLabel").textContent = plural(accountTracks, "трек", "трека", "треков");
  $("#accountPlaysLabel").textContent = plural(accountPlays, "прослушивание", "прослушивания", "прослушиваний");
  $("#accountDownloadsLabel").textContent = plural(accountDownloads, "скачивание", "скачивания", "скачиваний");
  $("#accountJoined").textContent = user.created_at ? `С нами с ${formatDate(user.created_at)}` : "";

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
}

function renderMyTracks() {
  const container = $("#myTracks");
  if (!container) return;
  const mine = state.tracks.filter((track) => track.mine);

  if (mine.length === 0) {
    container.innerHTML = '<div class="my-empty">Вы ещё не загрузили ни одного трека.</div>';
    return;
  }

  container.innerHTML = mine.map((track) => `
    <div class="my-track">
      <div class="my-track-cover" style="--accent:${safeColor(track.author.accent)}">${esc(track.author.avatar || "🎵")}</div>
      <div class="my-track-info">
        <div class="my-track-title">${esc(track.title)}</div>
        <div class="my-track-meta">${formatSize(track.size)} · ${formatNumber(track.plays)} ${plural(track.plays, "прослушивание", "прослушивания", "прослушиваний")} · ${formatDate(track.created_at)}</div>
      </div>
      <div class="my-track-actions">
        <button class="icon-action" type="button" data-play="${track.id}" title="Слушать" aria-label="Слушать">${ICON_PLAY}</button>
        <button class="icon-action" type="button" data-edit="${track.id}" title="Редактировать" aria-label="Редактировать">${ICON_EDIT}</button>
        <button class="icon-action danger" type="button" data-delete="${track.id}" title="Удалить" aria-label="Удалить">${ICON_TRASH}</button>
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
    renderAuthArea();
    renderAccount();
    await loadTracks();
    toast("Профиль сохранён", "success");
  } catch (error) {
    toast(error.message, "error");
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
    const body = {
      username,
      email: $("#settingsEmail").value.trim(),
    };
    if (password) body.current_password = password;
    const data = await api("/api/account", { method: "PATCH", body });
    state.user = data.user;
    renderAuthArea();
    renderAccount();
    await loadTracks();
    toast("Данные аккаунта обновлены", "success");
  } catch (error) {
    toast(error.message, "error");
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
    await api("/api/account", {
      method: "PATCH",
      body: { current_password: current, new_password: next },
    });
    $("#passwordCurrent").value = "";
    $("#passwordNew").value = "";
    $("#passwordRepeat").value = "";
    toast("Пароль изменён. Другие сеансы завершены.", "success");
  } catch (error) {
    toast(error.message, "error");
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
    hidePlayer();
    state.user = null;
    renderAuthArea();
    $("#deleteForm").reset();
    await loadTracks();
    setView("home");
    toast("Аккаунт удалён", "success");
  } catch (error) {
    toast(error.message, "error");
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
    if (state.currentId === data.track.id) updatePlayerInfo(data.track);
    closeEdit();
    renderTracks();
    renderMyTracks();
    toast("Трек обновлён", "success");
  } catch (error) {
    toast(error.message, "error");
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
    renderTracks();
    updateStats();
    if (state.user) {
      await loadMe().catch(() => {});
      renderMyTracks();
    }
    toast("Трек удалён");
  } catch (error) {
    toast(error.message, "error");
  }
}

/* ---------- События ---------- */

function bindEvents() {
  // Навигация
  $$("[data-view-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setView(link.dataset.viewLink);
    });
  });

  document.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (actionButton && actionButton.dataset.action === "go-upload") {
      setView("upload");
      return;
    }

    const playButton = event.target.closest("[data-play]");
    if (playButton) {
      const track = trackById(playButton.dataset.play);
      if (track) togglePlay(track);
      return;
    }

    const authorButton = event.target.closest("[data-author]");
    if (authorButton) {
      setAuthorFilter(authorButton.dataset.author);
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
          track.downloads += 1;
          updateTrackMeta(track);
        }, 900);
      }
    }
  });

  // Шапка
  $("#authArea").addEventListener("click", (event) => {
    if (event.target.closest("#loginOpen")) openAuth("login");
    if (event.target.closest("#userChip")) setView("account");
    if (event.target.closest("#headerLogout")) logout();
  });

  // Поиск и фильтр
  let searchTimer = null;
  $("#searchInput").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.query = value.trim();
      renderTracks();
    }, 140);
  });

  $("#clearAuthorFilter").addEventListener("click", clearAuthorFilter);
  $("#heroListen").addEventListener("click", () => {
    const first = filteredTracks()[0];
    if (first) togglePlay(first);
    else toast("В ленте пока нет треков");
  });

  // Модальное окно входа
  $$("[data-close-auth]").forEach((el) => el.addEventListener("click", closeAuth));
  $$("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => switchAuthTab(button.dataset.authTab));
  });
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#registerForm").addEventListener("submit", handleRegister);

  // Модальное окно редактирования
  $$("[data-close-edit]").forEach((el) => el.addEventListener("click", closeEdit));
  $("#editForm").addEventListener("submit", saveEdit);

  // Загрузка
  bindDropzone();
  $("#uploadForm").addEventListener("submit", handleUpload);
  $("#uploadTitle").addEventListener("input", updateTitleCounter);

  // Кабинет
  $("#profileForm").addEventListener("submit", saveProfile);
  $("#accountForm").addEventListener("submit", saveAccount);
  $("#passwordForm").addEventListener("submit", savePassword);
  $("#deleteForm").addEventListener("submit", deleteAccount);
  $("#logoutBtn").addEventListener("click", logout);

  $("#settingsAvatar").addEventListener("input", (event) => {
    const value = event.target.value.trim() || "🎵";
    $("#avatarPreview").textContent = value;
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

  // Клавиатура
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

  window.addEventListener("hashchange", () => {
    const name = window.location.hash.replace("#", "") || "home";
    if (name !== state.view) setView(name, { noHash: true, noScroll: true });
  });
}

/* ---------- Старт ---------- */

async function init() {
  bindEvents();
  setRangeFill($("#volumeBar"), 100);
  setRangeFill($("#seekBar"), 0);

  try {
    await loadMe();
  } catch (error) {
    toast(error.message, "error");
  }

  try {
    await loadTracks();
  } catch (error) {
    toast(error.message, "error");
  }

  const initial = (window.location.hash || "#home").replace("#", "");
  let target = ["home", "upload", "account"].includes(initial) ? initial : "home";
  if ((target === "upload" || target === "account") && !state.user) target = "home";
  setView(target, { noHash: true, noScroll: true });

  if (state.user) {
    renderAccount();
  }
}

document.addEventListener("DOMContentLoaded", init);
