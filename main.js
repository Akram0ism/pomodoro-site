(() => {
  // ===== Cross-tab/state sync для PiP =====
  // ===== Cross-tab/state sync для PiP =====
  let bc;
  try {
    bc =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('pomodoro-sync')
        : null;
  } catch (_) {
    bc = null;
  }
  // простой no-op, чтобы вызовы не падали
  const BC = {
    postMessage: (...args) => {
      try {
        bc?.postMessage?.(...args);
      } catch {}
    },
    // подписка через bc.onmessage уже ниже — оставим как есть, но защитим:
  };
  let pipWindow = null;

  // Safari/Firefox: нет Document PiP → используем оверлей
  const USE_OVERLAY_ONLY = !('documentPictureInPicture' in window);
  // Разрешаем оверлей (оставь true, чтобы можно было вызвать вручную везде)
  const OVERLAY_ENABLED = true;

  // src/main.js
  let mirror = null;
  // Отправка текущего состояния в канал

  const BUS_KEY = 'pomodoro-sync-msg';

  function busPost(msg) {
    // основной путь — BroadcastChannel
    try {
      BC.postMessage(msg);
    } catch {}
    // фолбэк — через storage-событие
    try {
      localStorage.setItem(BUS_KEY, JSON.stringify({ t: Date.now(), msg }));
    } catch {}
  }

  window.addEventListener('storage', (e) => {
    if (e.key === BUS_KEY && e.newValue) {
      try {
        const { msg } = JSON.parse(e.newValue);
        handleBusMessage(msg);
      } catch {}
    }
  });

  function broadcastState() {
    try {
      BC.postMessage({
        type: 'state',
        payload: {
          remaining: state.remaining,
          mode: state.mode,
          running: state.running,
        },
      });
    } catch {}
  }
  function handleBusMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'state' && msg.payload) {
      mirror = msg.payload;
      if (USE_OVERLAY_ONLY && OVERLAY_ENABLED && !overlayEl) ensureOverlay();
      updateOverlay(mirror);
      return;
    }

    if (msg.type === 'cmd') {
      const act = msg.action;
      if (act === 'toggle') return state.running ? pause() : start();
      if (act === 'switch' && ['focus', 'short', 'long'].includes(msg.mode)) {
        switchMode(msg.mode, true);
        return;
      }
    }
  }

  if (bc) {
    bc.onmessage = (ev) => handleBusMessage(ev?.data);
  }

  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ===== Восстановление сессии после магической ссылки =====
  if (location.hash.includes('access_token')) {
    const params = new URLSearchParams(location.hash.slice(1));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    supa.auth.getUser().then(({ data }) => {
      const user = data?.user;
      user ? onSignedIn(user) : onSignedOut();
    });

    supa.auth.onAuthStateChange((_evt, session) => {
      const user = session?.user;
      user ? onSignedIn(user) : onSignedOut();
    });

    // Устанавливаем сессию вручную
    supa.auth.setSession({ access_token, refresh_token }).then(() => {
      // очищаем hash из URL
      history.replaceState({}, document.title, location.pathname);
    });
  }

  // ===== Helpers
  function addFocusMinutes(min, pid) {
    const d = nowISO();
    const h = new Date().getHours();

    state.stats.todayFocusMin += min;
    state.stats.totalFocusMin += min;
    state.stats.history[d] = (state.stats.history[d] || 0) + min;
    state.stats.todayByHour[h] = (state.stats.todayByHour[h] || 0) + min;

    const ps =
      state.stats.project[pid] ||
      (state.stats.project[pid] = {
        total: 0,
        history: {},
        todayByHour: Array.from({ length: 24 }, () => 0),
      });
    ps.total += min;
    ps.history[d] = (ps.history[d] || 0) + min;
    ps.todayByHour[h] = (ps.todayByHour[h] || 0) + min;

    // в облако (best-effort)
    try {
      pushStatsToCloud({ day: d, minutes: min, projectId: pid });
    } catch {}
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const fmt = (s) => String(Math.floor(s)).padStart(2, '0');
  // ==== colors for projects
  function randColor() {
    // приятные пастельные
    const h = Math.floor(Math.random() * 360);
    return `#${h.toString(16).padStart(2, '0')}7cff`.slice(0, 7); // запасной простой генератор
  }
  function getProjectColor(pid) {
    const p = state.projects.find((x) => x.id === pid);
    return p?.color || '#7c5cff';
  }

  // ===== Welcome banner (персональное приветствие)

  function escapeHtml(s = '') {
    return String(s).replace(
      /[&<>"']/g,
      (m) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[m])
    );
  }

  function updateWelcome(user) {
    const el = document.getElementById('welcomeText');
    if (!el) return;

    if (user) {
      const name =
        user.user_metadata?.name ||
        (user.email ? user.email.split('@')[0] : 'пользователь');
      el.innerHTML = `👋 Здравствуйте, <b>${escapeHtml(name)}</b>!`;
    } else {
      el.innerHTML =
        'Простая система для фокуса: 25/5, длинный перерыв каждые 4 сета. ' +
        'Горячие клавиши: <b>Space</b> — старт/пауза, <b>R</b> — сброс, <b>1</b>/<b>2</b>/<b>3</b> — режимы.';
    }
  }

  // === SAFETY UTILS: санитайзеры и проверки ===
  function sanitizeText(s, max = 80) {
    s = String(s ?? '').trim();
    if (s.length > max) s = s.slice(0, max);
    return s;
  }
  function sanitizeNumber(n, { min = 0, max = 9999, fallback = 0 } = {}) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }
  function safeTextNode(parent, text) {
    // безопасно вставить текст (без innerHTML)
    parent.textContent = String(text ?? '');
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (USE_OVERLAY_ONLY && OVERLAY_ENABLED && !overlayEl) {
      // лёгкая задержка, чтобы точно был body
      setTimeout(() => {
        try {
          ensureOverlay();
          updateOverlay();
        } catch {}
      }, 0);
    }
  });

  document.getElementById('forceOverlayBtn')?.addEventListener('click', () => {
    if (OVERLAY_ENABLED) ensureOverlay();
  });
  // toast уведомление
  function ensureToastEl() {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(message) {
    const el = ensureToastEl();
    el.innerHTML = ''; // очищаем
    const ok = document.createElement('span');
    ok.className = 'ok';
    ok.textContent = '✔';
    const msg = document.createElement('span');
    msg.textContent = String(message ?? '');
    el.append(ok, msg);

    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ===== Topbar Auth UI =====
  const authIcon = document.getElementById('authIcon');
  const authMenu = document.getElementById('authMenu');
  const authEmailDisplay = document.getElementById('authEmailDisplay');
  const authLoginBtn = document.getElementById('authLoginBtn');
  const authLogoutBtn = document.getElementById('authLogoutBtn');
  const authMenuEmail = document.getElementById('authMenuEmail');
  const authPassInput = document.getElementById('authMenuPass');
  const authSignupBtn = document.getElementById('authSignupBtn');
  const authGoogleBtn = document.getElementById('authGoogleBtn');

  // вспом: редирект назад на ту же страницу
  const REDIRECT_TO = `https://akram0ism.github.io/pomodoro-site/`;

  // Вход по email+пароль
  if (authLoginBtn)
    authLoginBtn.onclick = async () => {
      if (!supa) return showToast('Supabase клиент не инициализирован');
      const email = (authMenuEmail?.value || '').trim();
      const password = (authPassInput?.value || '').trim();
      if (!email || !password) {
        showToast('Введите e-mail и пароль');
        return;
      }

      const { data, error } = await supa.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return showToast('Ошибка входа: ' + error.message);

      showToast('Вы вошли');
      authMenu?.classList.add('hidden');
    };

  // Регистрация (e-mail + пароль)
  if (authSignupBtn)
    authSignupBtn.onclick = async () => {
      if (!supa) return showToast('Supabase клиент не инициализирован');
      const email = (authMenuEmail?.value || '').trim();
      const password = (authPassInput?.value || '').trim();
      if (!email || !password) {
        showToast('Задайте e-mail и пароль');
        return;
      }
      if (password.length < 6) {
        showToast('Пароль >= 6 символов');
        return;
      }

      const { data, error } = await supa.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: REDIRECT_TO,
          // можно сохранить доп. поля профиля
          data: { name: email.split('@')[0] },
        },
      });
      if (error) return showToast('Ошибка регистрации: ' + error.message);

      if (data.user?.identities?.length === 0) {
        // такой пользователь уже есть
        showToast('Пользователь уже существует. Попробуй «Войти».');
      } else {
        showToast('Письмо для подтверждения отправлено на почту');
      }
    };

  // Вход через Google (OAuth)
  if (authGoogleBtn)
    authGoogleBtn.onclick = async () => {
      if (!supa) return showToast('Supabase клиент не инициализирован');
      const { data, error } = await supa.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: REDIRECT_TO,
          queryParams: {
            // подсказка выбора аккаунта
            prompt: 'select_account',
          },
        },
      });
      if (error) showToast('Ошибка Google OAuth: ' + error.message);
    };

  // Логаут
  if (authLogoutBtn)
    authLogoutBtn.onclick = async () => {
      await supa.auth.signOut();
      authMenu?.classList.add('hidden');
      showToast('Вы вышли');
    };

  authIcon.textContent = '👤'; // default

  // Enter в поле пароля = нажать "Войти"
  authPassInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authLoginBtn?.click();
  });

  // Показ/скрытие меню (если ещё не сделал вариант с бекдропом)
  authIcon.onclick = () => {
    authMenu?.classList.toggle('hidden');
  };

  // запуск по Enter
  authMenuEmail?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authLoginBtn.click();
  });

  // Обновление UI при изменении статуса
  function updateAuthUI(user) {
    if (!authIcon || !authEmailDisplay || !authLoginBtn || !authLogoutBtn)
      return;

    if (user) {
      authIcon.textContent = '✅';
      authEmailDisplay.textContent = user.email;
      authLoginBtn.style.display = 'none';
      authLogoutBtn.style.display = 'block';
      authMenuEmail && (authMenuEmail.style.display = 'none');
      authPassInput && (authPassInput.style.display = 'none');
      authSignupBtn && (authSignupBtn.style.display = 'none');
      authGoogleBtn && (authGoogleBtn.style.display = 'none');
    } else {
      authIcon.textContent = '👤';
      authEmailDisplay.textContent = 'Не вошли';
      authLoginBtn.style.display = 'block';
      authLogoutBtn.style.display = 'none';
      authMenuEmail && (authMenuEmail.style.display = '');
      authPassInput && (authPassInput.style.display = '');
      authSignupBtn && (authSignupBtn.style.display = '');
      authGoogleBtn && (authGoogleBtn.style.display = '');
    }
  }
  // ===== State & Persistence
  const LS_KEY = 'pomodoro.v2';
  const nowISO = () => new Date().toISOString().slice(0, 10);

  const defaultState = {
    settings: {
      focus: 25,
      short: 5,
      long: 15,
      roundsToLong: 4,
      autoNext: false,
      soundOn: true,
      notifyOn: false,
      soundVolume: 0.8,
    },
    mode: 'focus',
    rounds: 1,
    remaining: 25 * 60,
    running: false,
    tasks: [],
    projects: [{ id: 'default', name: 'Общее', color: '#7c5cff' }],
    activeProjectId: 'default',
    stats: {
      todayDate: nowISO(),
      todayFocusMin: 0,
      setsDone: 0,
      totalFocusMin: 0,
      history: {},
      todayByHour: Array.from({ length: 24 }, () => 0),
      project: {
        default: {
          total: 0,
          history: {},
          todayByHour: Array.from({ length: 24 }, () => 0),
        },
      },
    },
  };

  let state = load() || defaultState;
  migrateState();

  function load() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY));
    } catch (e) {
      return null;
    }
  }
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function migrateState() {
    const d = nowISO();

    if (!state.stats)
      state.stats = {
        todayDate: d,
        todayFocusMin: 0,
        setsDone: 0,
        totalFocusMin: 0,
        history: {},
        todayByHour: Array.from({ length: 24 }, () => 0),
        project: {},
      };

    if (!state.stats.history) state.stats.history = {};
    if (state.settings.soundVolume == null) state.settings.soundVolume = 0.8;
    if (!state.stats.todayByHour)
      state.stats.todayByHour = Array.from({ length: 24 }, () => 0);

    // ⬇️ ВАЖНО: не пересоздаём дефолт, если projects — пустой массив
    if (!Array.isArray(state.projects)) {
      state.projects = [{ id: 'default', name: 'Общее', color: '#7c5cff' }];
    }

    if (!state.activeProjectId) {
      state.activeProjectId = state.projects[0]?.id || null;
    }

    if (!state.stats.project) state.stats.project = {};

    // гарантируем структуру для существующих проектов
    state.projects.forEach((p) => {
      if (!p.color) p.color = '#7c5cff';
      if (!state.stats.project[p.id]) {
        state.stats.project[p.id] = {
          total: 0,
          history: {},
          todayByHour: Array.from({ length: 24 }, () => 0),
        };
      }
    });

    // если вообще нет проектов — оставляем пусто, НИЧЕГО не создаём
    if (state.projects.length === 0) {
      state.activeProjectId = null;
    }

    if (state.stats.todayDate !== d) {
      state.stats.todayDate = d;
      state.stats.todayFocusMin = 0;
      state.stats.todayByHour = Array.from({ length: 24 }, () => 0);
      Object.values(state.stats.project).forEach(
        (ps) => (ps.todayByHour = Array.from({ length: 24 }, () => 0))
      );
    }
  }

  // ===== UI Elements
  const timeEl = $('#time'),
    startBtn = $('#startPause'),
    skipBtn = $('#skip'),
    commitBtn = $('#commitTime');
  const roundInfo = $('#roundInfo'),
    statusEl = $('#status'),
    currentTask = $('#currentTask');
  const modeTabs = $('#modeTabs');

  const focusMins = $('#focusMins'),
    shortMins = $('#shortMins'),
    longMins = $('#longMins'),
    roundsToLong = $('#roundsToLong');
  const autoNext = $('#autoNext'),
    soundOn = $('#soundOn'),
    notifyOn = $('#notifyOn');
  const soundVolume = document.getElementById('soundVolume');
  const soundVolumeVal = document.getElementById('soundVolumeVal');

  const saveSettingsBtn = $('#saveSettings'),
    resetStatsBtn = $('#resetStats');
  const kpiToday = $('#kpiToday'),
    kpiSets = $('#kpiSets'),
    kpiTotal = $('#kpiTotal');

  const taskText = $('#taskText'),
    addTask = $('#addTask'),
    taskList = $('#taskList');

  const activeProjectSel = $('#activeProject');
  const quickAddProject = $('#quickAddProject');
  // прячем кнопку «+ Проект» под таймером и отключаем клики
  if (quickAddProject) {
    quickAddProject.style.display = 'none';
    quickAddProject.style.pointerEvents = 'none';
  }

  const newProjectName = $('#newProjectName');
  const addProjectBtn = $('#addProjectBtn');
  const projectList = $('#projectList');

  const chartTabs = document.getElementById('chartTabs');
  const chartCanvas = document.getElementById('focusChart');
  const chartProjectSel = document.getElementById('chartProject');
  // Auth UI

  // ===== Modes
  const MODES = [
    {
      id: 'focus',
      label: 'Фокус',
      get secs() {
        return state.settings.focus * 60;
      },
    },
    {
      id: 'short',
      label: 'Перерыв',
      get secs() {
        return state.settings.short * 60;
      },
    },
    {
      id: 'long',
      label: 'Длинный перерыв',
      get secs() {
        return state.settings.long * 60;
      },
    },
    {
      id: 'intense',
      label: 'Интенсив',
      get secs() {
        return 0;
      },
    }, // спец. режим
  ];

  function renderTabs() {
    modeTabs.innerHTML = '';
    MODES.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'tab' + (state.mode === m.id ? ' active' : '');
      b.textContent = m.label;
      b.onclick = () => {
        switchMode(m.id, true);
        renderTabs();
      };
      modeTabs.appendChild(b);
    });
  }

  function switchMode(id, manual = false) {
    state.mode = id;

    if (id === 'intense') {
      state.remaining = 0; // для интенсивного: elapsed в секундах
      state.running = false;
    } else {
      state.remaining = MODES.find((m) => m.id === id).secs;
      state.running = false;
    }

    state.running = false;
    state._committed = false;
    startBtn.textContent = 'Старт';
    statusEl.textContent = manual ? 'Режим переключён' : 'Готов';
    renderTime();
    updateWidget();
    save();
  }

  // ===== Timer Engine
  let raf, lastTick;
  function tick(ts) {
    if (!state.running) {
      lastTick = ts;
      raf = requestAnimationFrame(tick);
      return;
    }
    if (!lastTick) lastTick = ts;
    const dt = (ts - lastTick) / 1000;
    lastTick = ts;

    if (state.mode === 'intense') {
      // секундомер: считаем вверх
      state.remaining += dt;
    } else {
      // обычные режимы: считаем вниз
      state.remaining -= dt;
      if (state.remaining <= 0) {
        state.remaining = 0;
        state.running = false;
        try {
          onTimerEnd();
        } catch (e) {
          console.error('onTimerEnd error:', e);
        }
      }
    }

    renderTime();
    raf = requestAnimationFrame(tick);
  }

  async function start() {
    getAC();
    state.running = true;
    startBtn.textContent = 'Пауза';
    statusEl.textContent = 'Идёт…';
    save();
    broadcastState();

    try {
      if (USE_OVERLAY_ONLY) {
        if (OVERLAY_ENABLED) ensureOverlay();
      } else {
        // Chrome/Edge с поддержкой Document PiP
        if (!pipWindow) {
          pipWindow = await openPip();
        }
        // Если вдруг окно не открылось — резервный оверлей
        if (!pipWindow && OVERLAY_ENABLED) ensureOverlay();
      }
    } catch (e) {
      console.error('PiP/Overlay init failed:', e);
      if (OVERLAY_ENABLED) ensureOverlay();
    }
  }
  // ===== Document Picture-in-Picture =====
  async function openPip() {
    if (!('documentPictureInPicture' in window)) return null;

    // открываем мини-окно
    const win = await documentPictureInPicture.requestWindow({
      width: 160,
      height: 100,
    });
    pipWindow = win;

    win.addEventListener('pagehide', () => {
      pipWindow = null;
    });

    const doc = win.document;
    doc.body.style.margin = '0';
    doc.body.style.fontFamily = 'system-ui,-apple-system,Segoe UI,Roboto,Arial';
    doc.body.style.background = '#121a33';
    doc.body.style.color = '#e2e8f0';
    doc.body.style.display = 'flex';
    doc.body.style.flexDirection = 'column';
    doc.body.style.justifyContent = 'center';
    doc.body.style.alignItems = 'center';
    doc.body.style.userSelect = 'none';

    // 💠 Минималистичный контент — только статус и время
    doc.body.innerHTML = `
      <div id="pipStatus" style="font-size:14px;margin-bottom:4px;">Фокус</div>
      <div id="pipTime" style="font-size:34px;font-weight:800;text-align:center;">25:00</div>
    `;

    // обновление при каждом сообщении из основного окна
    const pipChannel = new BroadcastChannel('pomodoro-sync');
    pipChannel.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'state') renderPip(msg.payload || {});
    };

    // рендер текущего состояния
    function renderPip(payload) {
      if (!pipWindow) return;
      const t = doc.getElementById('pipTime');
      const s = doc.getElementById('pipStatus');
      if (!t || !s) return;
      const secs = Math.ceil(payload.remaining ?? 0);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      t.textContent = `${mm}:${ss}`;
      s.textContent =
        payload.mode === 'focus'
          ? 'Фокус'
          : payload.mode === 'short'
          ? 'Перерыв'
          : payload.mode === 'long'
          ? 'Длинный'
          : payload.mode === 'intense'
          ? 'Интенсив'
          : '—';
    }

    // сразу показать начальные данные
    renderPip({
      remaining: state.remaining,
      mode: state.mode,
      running: state.running,
    });

    return win;
  }

  function onTimerEnd() {
    if (state.mode === 'intense') return;
    statusEl.textContent = 'Готов';
    notify('Время вышло', labelFor(state.mode));
    if (state.settings.soundOn) beep();

    // === Обновляем статистику, если это был фокус ===
    if (state.mode === 'focus') {
      if (state.mode === 'focus' && !state._skipped) {
        const addMin = Math.round(MODES[0].secs / 60);
        state.stats.todayFocusMin += addMin;
        state.stats.totalFocusMin += addMin;
        state.stats.setsDone += 1;
        const d = nowISO();
        state.stats.history[d] = (state.stats.history[d] || 0) + addMin;
        const h = new Date().getHours();
        state.stats.todayByHour[h] = (state.stats.todayByHour[h] || 0) + addMin;
        const pid = state.activeProjectId;
        const ps =
          state.stats.project[pid] ||
          (state.stats.project[pid] = {
            total: 0,
            history: {},
            todayByHour: Array.from({ length: 24 }, () => 0),
          });
        ps.total += addMin;
        ps.history[d] = (ps.history[d] || 0) + addMin;
        ps.todayByHour[h] = (ps.todayByHour[h] || 0) + addMin;
        state.rounds = (state.rounds % state.settings.roundsToLong) + 1;
        renderChart();
      }
    }
    state._skipped = false;
    // === Определяем следующий режим ===
    let nextMode;
    if (state.mode === 'focus') {
      nextMode =
        (state.rounds - 1) % state.settings.roundsToLong === 0
          ? 'long'
          : 'short';
    } else {
      nextMode = 'focus';
    }

    state.mode = nextMode;
    state.remaining = MODES.find((m) => m.id === nextMode).secs;

    // === Проверяем автостарт ===
    if (state.settings.autoNext) {
      state.running = true;
      startBtn.textContent = 'Пауза';
      statusEl.textContent = 'Идёт…';
    } else {
      state.running = false;
      startBtn.textContent = 'Старт';
      statusEl.textContent = 'Готов';
    }

    renderTabs();
    renderTime();
    renderKPIs();
    renderRound();
    save();
    broadcastState();
  }

  // ===== Overlay (плавающий мини-виджет) =====
  let overlayEl = null;

  function ensureOverlay() {
    // если уже есть виджет — просто обновляем
    if (overlayEl && document.body.contains(overlayEl)) {
      updateOverlay();
      return;
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', ensureOverlay, {
        once: true,
      });
      return;
    }

    // удаляем старый (если залипший)
    document.querySelector('#pomodoroOverlay')?.remove();

    overlayEl = document.createElement('div');
    overlayEl.id = 'pomodoroOverlay';
    overlayEl.style.cssText = `
    position:fixed; right:16px; bottom:16px;
    z-index:2147483647; /* было 9999 */
    background:#121a33; color:#e2e8f0; border:1px solid rgba(255,255,255,.12);
    border-radius:12px; padding:10px 12px; width:180px;
    box-shadow:0 10px 30px rgba(0,0,0,.35);
    font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
  `;

    overlayEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <strong id="ovStatus" style="font-size:13px">Фокус</strong>
      <button id="ovClose" title="Закрыть"
        style="background:#0f1630;border:1px solid rgba(255,255,255,.12);color:#dbe3f0;
        border-radius:8px;cursor:pointer;">×</button>
    </div>
    <div id="ovTime" style="font-size:26px;font-weight:800;text-align:center;">25:00</div>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">
      <button id="ovToggle" style="background:#0f1630;border:1px solid rgba(255,255,255,.12);
        color:#dbe3f0;border-radius:8px;cursor:pointer;padding:6px 10px;">▶️</button>
      <button id="ovFocus"  title="Фокус"   style="background:#0f1630;border:1px solid rgba(255,255,255,.12);
        color:#dbe3f0;border-radius:8px;cursor:pointer;padding:6px 10px;">🎯</button>
      <button id="ovShort"  title="Перерыв" style="background:#0f1630;border:1px solid rgba(255,255,255,.12);
        color:#dbe3f0;border-radius:8px;cursor:pointer;padding:6px 10px;">☕</button>
      <button id="ovLong"   title="Длинный" style="background:#0f1630;border:1px solid rgba(255,255,255,.12);
        color:#dbe3f0;border-radius:8px;cursor:pointer;padding:6px 10px;">🕒</button>
    </div>
  `;
    document.body.appendChild(overlayEl);

    // получаем ссылки на элементы
    const q = (sel) => overlayEl.querySelector(sel);

    // кнопки
    q('#ovClose')?.addEventListener('click', () => {
      overlayEl.remove();
      overlayEl = null;
    });
    q('#ovToggle')?.addEventListener('click', () => {
      busPost({ type: 'cmd', action: 'toggle' });
    });

    q('#ovFocus')?.addEventListener('click', () => {
      busPost({ type: 'cmd', action: 'switch', mode: 'focus' });
    });

    q('#ovShort')?.addEventListener('click', () => {
      busPost({ type: 'cmd', action: 'switch', mode: 'short' });
    });

    q('#ovLong')?.addEventListener('click', () => {
      busPost({ type: 'cmd', action: 'switch', mode: 'long' });
    });

    updateOverlay();
  }

  function updateOverlay(payload) {
    if (!overlayEl) return;
    const timeNode = overlayEl.querySelector('#ovTime');
    const statusNode = overlayEl.querySelector('#ovStatus');
    const toggleNode = overlayEl.querySelector('#ovToggle');
    if (!timeNode || !statusNode || !toggleNode) return;

    // если прилетел payload из другой вкладки — используем его, иначе свой state
    const src = payload || mirror || state;

    const secs = Math.max(0, Math.ceil(src.remaining ?? 0));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    timeNode.textContent = `${mm}:${ss}`;

    statusNode.textContent =
      src.mode === 'focus'
        ? 'Фокус'
        : src.mode === 'short'
        ? 'Перерыв'
        : src.mode === 'long'
        ? 'Длинный'
        : src.mode === 'intense'
        ? 'Интенсив'
        : '—';

    toggleNode.textContent = src.running ? '⏸️' : '▶️';
  }

  // ===== Pause (остановка таймера + закрытие PiP) =====
  function pause() {
    state.running = false;
    if (typeof startBtn !== 'undefined' && startBtn)
      startBtn.textContent = 'Старт';
    if (typeof statusEl !== 'undefined' && statusEl)
      statusEl.textContent = 'Пауза';
    save();
    broadcastState();

    // Закрываем PiP если он был
    if (pipWindow) {
      try {
        pipWindow.close?.();
      } catch {}
      pipWindow = null;
    }
  }

  // ===== Audio unlock & shared context
  let __ac; // shared AudioContext
  function getAC() {
    if (!__ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      __ac = new Ctx();
    }
    if (__ac.state === 'suspended') {
      // resume возвращает промис — необязательно await
      __ac.resume().catch(() => {});
    }
    return __ac;
  }

  // Разблокировать на первом пользовательском жесте
  function unlockAudioOnce() {
    try {
      getAC();
    } catch (e) {}
    document.removeEventListener('click', unlockAudioOnce);
    document.removeEventListener('keydown', unlockAudioOnce);
    document.removeEventListener('touchstart', unlockAudioOnce, {
      passive: true,
    });
  }
  document.addEventListener('click', unlockAudioOnce);
  document.addEventListener('keydown', unlockAudioOnce);
  document.addEventListener('touchstart', unlockAudioOnce, {
    passive: true,
  });

  // ===== Notifications & Sound (simple beep)
  function beep() {
    try {
      const audio = new Audio('bell.mp3'); // имя твоего файла
      audio.volume = state?.settings?.soundVolume ?? 0.8; // громкость с ползунка
      audio.play().catch((err) => console.warn('Ошибка воспроизведения:', err));
    } catch (e) {
      console.warn('Audio play failed:', e);
    }
  }

  function notify(title, body) {
    if (!state.settings.notifyOn) return;
    if (Notification.permission === 'granted')
      new Notification(title, { body });
    else if (Notification.permission !== 'denied')
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body });
      });
  }
  function labelFor(mode) {
    return mode === 'focus'
      ? 'Фокус'
      : mode === 'short'
      ? 'Короткий перерыв'
      : 'Длинный перерыв';
  }
  function updateWidget() {}
  // ===== Render helpers
  function renderTime() {
    const s = Math.ceil(state.remaining);
    timeEl.textContent = `${fmt(s / 60)}:${fmt(s % 60)}`;
    updateWidget(); // 🔄 обновляем виджет при каждом тике
    updateOverlay();
    broadcastState();
  }

  function renderKPIs() {
    kpiToday.textContent = `${state.stats.todayFocusMin} мин`;
    kpiSets.textContent = state.stats.setsDone;
    kpiTotal.textContent = `${state.stats.totalFocusMin} мин`;
  }
  function renderRound() {
    if (state.mode === 'intense') {
      roundInfo.textContent = `Интенсивный режим`;
      return;
    }
    roundInfo.textContent = `Раунд ${state.rounds}/${state.settings.roundsToLong}`;
  }

  function renderTasks() {
    taskList.innerHTML = '';
    state.tasks.forEach((t) => {
      const e = document.createElement('div');
      e.className = 'task' + (t.done ? ' done' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.done;
      cb.onchange = () => {
        t.done = cb.checked;
        save();
        renderTasks();
      };
      const span = document.createElement('div');
      span.textContent = t.text;
      const del = document.createElement('button');
      del.className = 'btn ghost';
      del.textContent = '×';
      del.onclick = () => {
        state.tasks = state.tasks.filter((x) => x.id !== t.id);
        save();
        renderTasks();
        updateCurrentTask();
      };
      e.append(cb, span, del);
      taskList.appendChild(e);
    });
    updateCurrentTask();
  }
  function updateCurrentTask() {
    const t = state.tasks.find((t) => !t.done);
    currentTask.textContent = 'Задача: ' + (t ? t.text : '—');
  }

  function renderProjectsUI() {
    // --- activeProject <select>
    activeProjectSel.innerHTML = '';
    state.projects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === state.activeProjectId) opt.selected = true;
      activeProjectSel.appendChild(opt);
    });
    // индикатор цвета активного проекта
    const activeDot = document.getElementById('activeProjectDot');
    if (activeDot)
      activeDot.style.background = getProjectColor(state.activeProjectId);

    // --- chartProject <select>
    chartProjectSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '__all__';
    optAll.textContent = 'Все проекты';
    chartProjectSel.appendChild(optAll);
    state.projects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      chartProjectSel.appendChild(opt);
    });
    if (
      !['__all__', ...state.projects.map((p) => p.id)].includes(
        chartProjectSel.value
      )
    ) {
      chartProjectSel.value = '__all__';
    }

    // --- список проектов (клик по названию/точке делает активным)
    projectList.innerHTML = '';
    state.projects.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.justifyContent = 'space-between';
      row.dataset.id = p.id;

      const info = document.createElement('div');
      info.style.cursor = 'pointer';
      info.title = 'Сделать активным';
      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = p.color || '#7c5cff';
      dot.title = p.color || '#7c5cff';
      const nameEl = document.createElement('span');
      nameEl.textContent = ' ' + p.name;
      info.append(dot, nameEl);

      // Клик по info — активирует проект
      info.onclick = () => {
        state.activeProjectId = p.id;
        save();
        renderProjectsUI();
        renderChart(); // чтобы перекрасить график под цвет проекта
      };

      // Подсветка активного проекта
      if (p.id === state.activeProjectId) {
        nameEl.style.fontWeight = '800';
        row.style.outline = '1px solid rgba(124,92,255,.35)';
        row.style.background = 'rgba(124,92,255,.08)';
      }

      const right = document.createElement('div');
      right.className = 'row';

      // Изменение цвета проекта
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = p.color || '#7c5cff';
      colorInput.style.width = '38px';
      colorInput.style.height = '28px';
      colorInput.style.border = 'none';
      colorInput.style.background = 'transparent';
      colorInput.title = 'Цвет проекта';
      colorInput.oninput = () => {
        p.color = colorInput.value;
        dot.style.background = p.color;
        if (p.id === state.activeProjectId && activeDot) {
          activeDot.style.background = p.color;
        }
        save();
        renderChart();
        pushProjectToCloud({
          id: p.id,
          name: p.name,
          color: p.color,
        }).catch(() => {});
      };

      // Удаление проекта
      const delBtn = document.createElement('button');
      delBtn.className = 'pill';
      delBtn.textContent = 'Удалить';
      delBtn.type = 'button';
      delBtn.dataset.action = 'delete';
      delBtn.dataset.id = p.id;

      right.append(colorInput, delBtn);
      row.append(info, right);
      projectList.appendChild(row);
    });
    if (!state.activeProjectId) {
      const activeDot = document.getElementById('activeProjectDot');
      if (activeDot) activeDot.style.background = 'transparent';
      if (activeProjectSel) activeProjectSel.value = '';
    }
  }

  function render() {
    if (focusMins) focusMins.value = state.settings.focus;
    if (shortMins) shortMins.value = state.settings.short;
    if (longMins) longMins.value = state.settings.long;
    if (roundsToLong) roundsToLong.value = state.settings.roundsToLong;

    if (autoNext) autoNext.checked = state.settings.autoNext;
    if (soundOn) soundOn.checked = state.settings.soundOn;
    if (notifyOn) notifyOn.checked = state.settings.notifyOn;

    if (soundVolume) {
      soundVolume.value = Math.round(state.settings.soundVolume * 100);
      if (soundVolumeVal) soundVolumeVal.textContent = soundVolume.value;
      soundVolume.addEventListener('input', () => {
        if (soundVolumeVal) soundVolumeVal.textContent = soundVolume.value;
        soundVolume.style.setProperty('--pos', soundVolume.value + '%');
      });
    }

    renderTabs();
    renderTime();
    renderRound();
    renderKPIs();
    renderTasks();
    renderProjectsUI();
  }

  // ===== Events
  startBtn.onclick = () => {
    if (state.mode === 'intense') {
      // В интенсиве "Старт" -> запускает, повторное нажатие не ставит паузу
      if (!state.running) start();
      else {
        // Ничего не делаем, чтобы не было паузы.
        showToast(
          'В интенсивном режиме пауза отключена. Нажмите «Засчитать» для фиксации.'
        );
      }
    } else {
      state.running ? pause() : start();
    }
  };

  // ===== Commit (зачесть минуты и СБРОСИТЬ таймер) =====
  commitBtn.onclick = () => {
    if (state.mode === 'intense') {
      const elapsedMin = Math.max(0, Math.round(state.remaining / 60));
      if (elapsedMin <= 0) return showToast('Пока нечего засчитывать.');

      addFocusMinutes(elapsedMin, state.activeProjectId);
      showToast(`Засчитано: ${elapsedMin} мин`);

      state.running = false;
      state._skipped = false;
      state._committed = false;
      state.remaining = 0;

      startBtn.textContent = 'Старт';
      statusEl.textContent = 'Готов';

      save();
      renderTime();
      renderKPIs();
      renderChart();
      return;
    }

    // === дальше твоя прежняя логика для 'focus' ===
    if (state.mode !== 'focus') {
      showToast('Можно засчитать только в режиме «Фокус».');
      return;
    }

    const base = MODES.find((m) => m.id === 'focus').secs;
    const elapsedMin = Math.max(0, Math.round((base - state.remaining) / 60));
    if (elapsedMin <= 0) return showToast('Пока нечего засчитывать.');

    addFocusMinutes(elapsedMin, state.activeProjectId);
    showToast(`Засчитано: ${elapsedMin} мин`);

    state.running = false;
    state._skipped = false;
    state._committed = false;
    state.remaining = base;

    startBtn.textContent = 'Старт';
    statusEl.textContent = 'Готов';

    save();
    renderTime();
    renderKPIs();
    renderChart();
  };

  // засчитываем только в режиме фокуса

  activeProjectSel.onchange = () => {
    state.activeProjectId = activeProjectSel.value;
    save();
    const activeDot = document.getElementById('activeProjectDot');
    if (activeDot)
      activeDot.style.background = getProjectColor(state.activeProjectId);
  };
  if (quickAddProject) {
    quickAddProject.onclick = () => {
      let name = prompt('Название проекта:');
      name = sanitizeText(name, 40);
      if (!name) return;
      const color = prompt(
        'Цвет (#rrggbb), оставь пустым — случайный:'
      )?.trim();
      addProject(name, /^#([0-9a-f]{6})$/i.test(color) ? color : undefined);
    };
  }

  addProjectBtn.onclick = () => {
    const name = sanitizeText(newProjectName.value, 40);
    if (!name) return addProjectBtn.blur();
    addProject(name);
    newProjectName.value = '';
  };

  function addProject(name, color) {
    const id = crypto.randomUUID();
    const col = color || randColor();
    state.projects.push({ id, name, color: col });
    state.stats.project[id] = {
      total: 0,
      history: {},
      todayByHour: Array.from({ length: 24 }, () => 0),
    };
    state.activeProjectId = id;
    save();
    pushProjectToCloud({ id, name, color: col }).catch(() => {});
    renderProjectsUI();
    renderChart();
  }

  function deleteProject(id) {
    // удалить из массива проектов
    state.projects = state.projects.filter((p) => p.id !== id);

    // удалить локальную статистику этого проекта
    if (state.stats?.project) {
      delete state.stats.project[id];
    }

    // если удалили активный — выбрать следующий или null
    if (state.activeProjectId === id) {
      const next = state.projects[0]?.id || null;
      state.activeProjectId = next;
    }

    // если проектов больше нет — ничего не создаём автоматически
    save();
    renderProjectsUI();
    renderChart();
    renderKPIs();
    showToast('Проект удалён');
  }

  saveSettingsBtn.onclick = () => {
    const f = focusMins
      ? sanitizeNumber(focusMins.value, { min: 1, max: 300, fallback: 25 })
      : state.settings.focus;
    const s = shortMins
      ? sanitizeNumber(shortMins.value, { min: 1, max: 120, fallback: 5 })
      : state.settings.short;
    const l = longMins
      ? sanitizeNumber(longMins.value, { min: 1, max: 240, fallback: 15 })
      : state.settings.long;
    const r = roundsToLong
      ? sanitizeNumber(roundsToLong.value, { min: 2, max: 12, fallback: 4 })
      : state.settings.roundsToLong;
    const volPercent = soundVolume
      ? sanitizeNumber(soundVolume.value ?? 80, {
          min: 0,
          max: 100,
          fallback: 80,
        })
      : Math.round((state.settings.soundVolume ?? 0.8) * 100);
    const vol = volPercent / 100;

    state.settings = {
      focus: f,
      short: s,
      long: l,
      roundsToLong: r,
      autoNext: !!(autoNext && autoNext.checked),
      soundOn: !!(soundOn && soundOn.checked),
      notifyOn: !!(notifyOn && notifyOn.checked),
      soundVolume: vol,
    };

    if (state.mode === 'focus') state.remaining = f * 60;
    if (state.mode === 'short') state.remaining = s * 60;
    if (state.mode === 'long') state.remaining = l * 60;

    statusEl.textContent = 'Сохранено';
    save();
    renderTime();
  };

  resetStatsBtn.onclick = () => {
    // без confirm — сразу сбрасываем
    const d = nowISO();
    state.stats = {
      todayDate: d,
      todayFocusMin: 0,
      setsDone: 0,
      totalFocusMin: 0,
      history: {},
      todayByHour: Array.from({ length: 24 }, () => 0),
      project: {},
    };
    state.projects.forEach((p) => {
      state.stats.project[p.id] = {
        total: 0,
        history: {},
        todayByHour: Array.from({ length: 24 }, () => 0),
      };
    });
    save();
    renderKPIs();
    renderChart();

    // красивое уведомление
    showToast('Статистика сброшена');
  };
  addTask.onclick = addTaskFromInput;
  taskText.onkeydown = (e) => {
    if (e.key === 'Enter') {
      addTaskFromInput();
    }
  };
  function addTaskFromInput() {
    const t = sanitizeText(taskText.value, 120);
    if (!t) return;
    state.tasks.push({ id: crypto.randomUUID(), text: t, done: false });
    taskText.value = '';
    save();
    renderTasks();
  }

  window.addEventListener('error', (e) => {
    console.warn('GlobalError:', e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.warn('UnhandledPromise:', e.reason);
  });

  window.addEventListener('keydown', (e) => {
    if (
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
    )
      return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.mode === 'intense') {
        // В интенсиве пробел только запускает, без паузы
        if (!state.running) start();
        else
          showToast(
            'В интенсивном режиме пауза отключена. Нажмите «Засчитать».'
          );
      } else {
        state.running ? pause() : start();
      }
    }
    if (e.shiftKey && e.key.toLowerCase() === 'o') {
      if (OVERLAY_ENABLED) ensureOverlay();
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      commitBtn.click();
    }
    if (e.key === '1') {
      switchMode('focus', true);
      renderTabs();
    }
    if (e.key === '2') {
      switchMode('short', true);
      renderTabs();
    }
    if (e.key === '3') {
      switchMode('long', true);
      renderTabs();
    }
    if (e.key === '4') {
      switchMode('intense', true);
      renderTabs();
    }
  });

  async function onSignedIn(user) {
    updateAuthUI(user);
    updateWelcome(user);
    const welcome = document.getElementById('welcomeText');
    if (welcome) {
      const name = user.user_metadata?.name || user.email.split('@')[0];
    }

    try {
      const [projects, stats] = await Promise.all([
        pullProjectsFromCloud(),
        pullStatsFromCloud(120),
      ]);
      // merge projects
      if (projects?.length) {
        const existing = new Set(state.projects.map((p) => p.id));
        projects.forEach((p) => {
          if (!existing.has(p.id)) {
            state.projects.push({
              id: p.id,
              name: p.name,
              color: p.color || '#7c5cff',
            });
            state.stats.project[p.id] = state.stats.project[p.id] || {
              total: 0,
              history: {},
              todayByHour: Array.from({ length: 24 }, () => 0),
            };
          }
        });
      }
      // merge stats
      if (stats?.length) {
        stats.forEach((row) => {
          const day = row.day.slice(0, 10);
          const minutes = row.minutes | 0;
          if (row.project_id) {
            const ps =
              state.stats.project[row.project_id] ||
              (state.stats.project[row.project_id] = {
                total: 0,
                history: {},
                todayByHour: Array.from({ length: 24 }, () => 0),
              });
            ps.history[day] = Math.max(ps.history[day] || 0, minutes);
            ps.total = Object.values(ps.history).reduce((a, b) => a + b, 0);
          } else {
            state.stats.history[day] = Math.max(
              state.stats.history[day] || 0,
              minutes
            );
          }
        });
      }
      save();
      renderProjectsUI();
      renderChart();
      renderKPIs();
    } catch (err) {
      console.warn('sync failed', err);
    }
  }
  function onSignedOut() {
    updateAuthUI(null);
    updateWelcome(null);
    const welcome = document.getElementById('welcomeText');
    if (welcome) {
    }
  }

  if (supa) {
    supa.auth.getUser().then(({ data }) => {
      const user = data?.user;
      user ? onSignedIn(user) : onSignedOut();
    });
    supa.auth.onAuthStateChange((_evt, session) => {
      const user = session?.user;
      user ? onSignedIn(user) : onSignedOut();
    });
  } else {
    updateAuthUI(null);
    updateWelcome(null);
  }

  async function pushProjectToCloud({ id, name, color }) {
    if (!supa) return;
    const u = (await supa.auth.getUser()).data.user;
    if (!u) return;
    await supa.from('projects').upsert({ id, user_id: u.id, name, color });
  }

  async function deleteProjectFromCloud(id) {
    if (!supa) return;
    const u = (await supa.auth.getUser()).data.user;
    if (!u) return;
    await supa.from('projects').delete().eq('id', id).eq('user_id', u.id);
  }

  async function pushStatsToCloud({ day, minutes, projectId }) {
    if (!supa) return;
    const u = (await supa.auth.getUser()).data.user;
    if (!u) return;
    const { data: rows, error: selErr } = await supa
      .from('stats_by_day')
      .select('minutes')
      .eq('user_id', u.id)
      .eq('day', day)
      .eq('project_id', projectId || null)
      .limit(1);
    if (selErr) {
      console.warn(selErr);
      return;
    }
    const current = rows?.[0]?.minutes || 0;
    const total = current + minutes;
    const { error: upErr } = await supa.from('stats_by_day').upsert({
      user_id: u.id,
      project_id: projectId || null,
      day,
      minutes: total,
    });
    if (upErr) console.warn(upErr);
  }

  async function pullProjectsFromCloud() {
    if (!supa) return [];
    const u = (await supa.auth.getUser()).data.user;
    if (!u) return [];
    const { data } = await supa
      .from('projects')
      .select('id,name,color')
      .order('created_at', { ascending: true });
    return data || [];
  }
  async function pullStatsFromCloud(days) {
    if (!supa) return [];
    const u = (await supa.auth.getUser()).data.user;
    if (!u) return [];
    const since = new Date();
    since.setDate(since.getDate() - (days || 60));
    const { data } = await supa
      .from('stats_by_day')
      .select('day,minutes,project_id')
      .gte('day', since.toISOString().slice(0, 10));
    return data || [];
  }

  // ===== Chart helpers & data series
  let chart,
    chartRange = 'week';
  function getLastNDates(n) {
    const res = [];
    const base = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      res.push(d.toISOString().slice(0, 10));
    }
    return res;
  }
  function getSeries(range, projectId) {
    if (range === 'day') {
      // 24 часа: берём todayByHour
      const hours = Array.from({ length: 24 }, (_, h) => h);
      const labels = hours.map((h) => String(h).padStart(2, '0'));
      const data = hours.map((h) => {
        if (projectId && projectId !== '__all__') {
          return state.stats.project[projectId]?.todayByHour?.[h] || 0;
        }
        return state.stats.todayByHour?.[h] || 0;
      });
      return { labels, data };
    }
    const n = range === 'week' ? 7 : 30;
    const days = getLastNDates(n);
    const labels = days.map((d) => d.slice(5));
    const data = days.map((d) =>
      projectId && projectId !== '__all__'
        ? state.stats.project[projectId]?.history?.[d] || 0
        : state.stats.history[d] || 0
    );
    return { labels, data };
  }
  function renderChart(range = chartRange) {
    chartRange = range;

    const pid = chartProjectSel?.value || '__all__';
    const { labels, data } = getSeries(range, pid);
    const color = pid !== '__all__' ? getProjectColor(pid) : '#7c5cff';

    const ds = {
      label:
        pid === '__all__' ? 'Минуты фокуса (все проекты)' : 'Минуты фокуса',
      data,
      borderWidth: 1,
      backgroundColor: color + (color.length === 7 ? '99' : ''), // полупрозрачный
      borderColor: color,
      borderRadius: 4,
    };

    if (chart) {
      chart.config.type = 'bar';
      chart.data.labels = labels;
      chart.data.datasets[0].data = data;
      chart.data.datasets[0].label = ds.label;
      chart.data.datasets[0].backgroundColor = ds.backgroundColor;
      chart.data.datasets[0].borderColor = ds.borderColor;
      chart.update();
      return;
    }

    chart = new Chart(chartCanvas, {
      type: 'bar',
      data: { labels, datasets: [ds] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,.05)' },
            ticks: { color: '#a9b5c7' },
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,.07)' },
            ticks: { color: '#a9b5c7' },
          },
        },
        plugins: {
          legend: { labels: { color: '#dbe3f0' } },
          tooltip: { enabled: true },
        },
      },
    });
  }

  if (chartTabs) {
    chartTabs.addEventListener('click', (e) => {
      const b = e.target.closest('button.tab');
      if (!b) return;
      chartTabs
        .querySelectorAll('.tab')
        .forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      renderChart(b.dataset.range);
    });
  }
  if (chartProjectSel) {
    chartProjectSel.onchange = () => renderChart();
  }

  if (projectList) {
    projectList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'delete') {
        // Никаких confirm() — просто удаляем
        try {
          await deleteProjectFromCloud(id);
        } catch (err) {
          console.warn('cloud delete project failed', err);
        }
        try {
          await deleteProjectStatsFromCloud(id);
        } catch (err) {
          console.warn('cloud delete stats failed', err);
        }

        deleteProject(id); // локально
      }
    });
  }
  async function deleteProjectStatsFromCloud(projectId) {
    if (!supa) return;
    const u = (await supa.auth.getUser()).data.user;
    if (!u) return;
    // удалим все записи stats_by_day по этому проекту
    await supa
      .from('stats_by_day')
      .delete()
      .eq('user_id', u.id)
      .eq('project_id', projectId);
  }

  // ===== Self-tests (quick regression)
  (() => {
    try {
      console.group('%cPomodoro self-tests', 'color:#7c5cff');
      console.assert(
        typeof state.settings.focus === 'number' && state.settings.focus > 0,
        'focus setting'
      );
      console.assert(
        Array.isArray(state.projects) && state.projects.length >= 1,
        'projects exist'
      );
      console.assert(
        state.stats.project[state.activeProjectId],
        'active project stats exists'
      );
      const d1 = getSeries('day', '__all__');
      console.assert(d1.data.length === 24, 'day len');
      const d2 = getSeries('week', '__all__');
      console.assert(d2.data.length === 7, 'week len');
      const d3 = getSeries('month', '__all__');
      console.assert(d3.data.length === 30, 'month len');
      console.groupEnd();
    } catch (err) {
      console.warn('Self-tests failed', err);
    }
  })();

  // ===== Init
  render();
  renderChart('week');
  requestAnimationFrame(tick);

  function loadAdSense(clientId) {
    const s = document.createElement('script');
    s.async = true;
    s.src =
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' +
      encodeURIComponent(clientId);
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);

    const right = document.getElementById('adRight');
    if (right) {
      right.innerHTML = `
        <ins class="adsbygoogle"
             style="display:block"
             data-ad-client="ca-pub-4263398644681945"
             data-ad-slot="9510004602"
             data-ad-format="rectangle"
             data-full-width-responsive="true"></ins>`;
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    }
  }

  function setupConsent(clientIdForAdSense) {
    const banner = document.getElementById('cookieBanner');
    const accept = document.getElementById('cookieAccept');
    const decline = document.getElementById('cookieDecline');
    const key = 'consent.ads';

    const saved = localStorage.getItem(key);
    if (saved === null) {
      banner.style.display = 'block';
    } else if (saved === 'yes' && clientIdForAdSense) {
      loadAdSense(clientIdForAdSense);
    }

    accept?.addEventListener('click', () => {
      localStorage.setItem(key, 'yes');
      banner.style.display = 'none';
      if (clientIdForAdSense) loadAdSense(clientIdForAdSense);
    });
    decline?.addEventListener('click', () => {
      localStorage.setItem(key, 'no');
      banner.style.display = 'none';
    });
  }

  // вызови после DOMContentLoaded:
  document.addEventListener('DOMContentLoaded', () => {
    // Если используешь AdSense — передай свой clientId:
    setupConsent('ca-pub-4263398644681945');
    // Если не используешь AdSense — передай null:
    // setupConsent(null);
  });

  // ===== Mini Tour (подсказка навигации) =====
  (function setupMiniTour() {
    const helpBtn = document.getElementById('helpBtn');
    if (!helpBtn) return;

    const steps = [
      {
        sel: '#modeTabs',
        title: 'Режимы',
        text: 'Переключайся между «Фокус», «Перерыв» и «Длинный».',
        place: 'bottom',
      },
      {
        sel: '#time',
        title: 'Таймер',
        text: 'Здесь идёт обратный отсчёт. Space — старт/пауза.',
        place: 'right',
      },
      {
        sel: '#startPause',
        title: 'Старт/Пауза',
        text: 'Запускай сессию, останавливай, или засчитывай минутки кнопкой «Зачесть».',
        place: 'top',
      },
      {
        sel: '#projectList',
        title: 'Проекты',
        text: 'Веди учёт фокус-минут по проектам и меняй цвета.',
        place: 'left',
      },
      {
        sel: '#focusChart',
        title: 'Статистика',
        text: 'Смотри прогресс по дням/неделям, фильтруй по проектам.',
        place: 'top',
      },
    ];

    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // не даём всплыть до #topbar/#authIcon
      startTour(steps);
    });

    // Дополнительно: горячая клавиша «?»
    window.addEventListener('keydown', (e) => {
      const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        document.activeElement.tagName
      );
      if (!isInput && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        startTour(steps);
      }
    });

    function startTour(steps) {
      let i = 0;
      const overlay = document.createElement('div');
      overlay.className = 'tour-overlay';
      overlay.addEventListener('click', () => end(true));
      document.body.appendChild(overlay);

      const ring = document.createElement('div');
      ring.className = 'tour-focus-ring';
      document.body.appendChild(ring);

      const tip = document.createElement('div');
      tip.className = 'tour-tip';
      document.body.appendChild(tip);

      let autoTimer = null;

      function go(n) {
        clearTimeout(autoTimer);
        i = n;
        if (i < 0 || i >= steps.length) {
          end();
          return;
        }

        const step = steps[i];
        const el = document.querySelector(step.sel);
        if (!el) {
          next();
          return;
        }

        // позиция и размеры цели
        const r = el.getBoundingClientRect();
        const pad = 6;
        ring.style.left = r.left - pad + 'px';
        ring.style.top = r.top - pad + 'px';
        ring.style.width = r.width + pad * 2 + 'px';
        ring.style.height = r.height + pad * 2 + 'px';

        // контент подсказки
        // контент подсказки без кнопки "Пропустить"
        tip.innerHTML = `
<h4>${step.title}</h4>
<div>${step.text}</div>
<div class="tour-controls">
  <button class="pill" id="tourPrev" ${i === 0 ? 'disabled' : ''}>Назад</button>
  <button class="pill primary" id="tourNext">${
    i === steps.length - 1 ? 'Готово' : 'Далее'
  }</button>
</div>
`;

        // позиционирование подсказки
        const tw = Math.min(320, Math.max(220, r.width));
        tip.style.width = tw + 'px';
        const gap = 10;
        let x = r.left,
          y = r.top;

        switch (step.place) {
          case 'bottom':
            x = r.left;
            y = r.bottom + gap;
            break;
          case 'top':
            x = r.left;
            y = r.top - tip.offsetHeight - gap;
            break;
          case 'left':
            x = r.left - tw - gap;
            y = r.top;
            break;
          default:
            x = r.right + gap;
            y = r.top;
            break; // right
        }
        // не вылезаем за экран
        x = Math.max(12, Math.min(x, window.innerWidth - tw - 12));
        y = Math.max(
          12,
          Math.min(y, window.innerHeight - tip.offsetHeight - 12)
        );
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';

        // кнопки
        tip.querySelector('#tourPrev')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          go(i - 1);
        });
        tip.querySelector('#tourNext')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          go(i + 1);
        });

        // авто-переход через 3.5 сек, если юзер не кликает
        autoTimer = setTimeout(() => go(i + 1), 3500);
      }

      function next() {
        go(i + 1);
      }
      function end(skipped) {
        clearTimeout(autoTimer);
        overlay.remove();
        ring.remove();
        tip.remove();
        if (!skipped) showToast('Подсказка завершена');
      }

      // перестановка при ресайзе/прокрутке
      const onRelayout = () => go(i);
      window.addEventListener('resize', onRelayout);
      window.addEventListener('scroll', onRelayout, true);
      const origEnd = end;
      end = function (skipped) {
        // обёртка, чтобы снять слушатели
        window.removeEventListener('resize', onRelayout);
        window.removeEventListener('scroll', onRelayout, true);
        origEnd(skipped);
      };

      go(0);
    }
  })();
})();
