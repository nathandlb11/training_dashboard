/* global Chart, Format, SessionLibrary, PlanBuilder */
(function () {
  'use strict';

  const boot = window.__PLANNING_BOOTSTRAP__ || {};
  if (!document.getElementById('planningLayout')) return;

  window.addEventListener('error', (e) => {
    const el = document.getElementById('intervalsLibrary');
    if (el) el.innerHTML = `<div class="alert alert-error" style="margin:10px;font-size:0.8rem;">JS Error: ${e.message}<br>${e.filename}:${e.lineno}</div>`;
  });

  const { SESSION_LIBRARY, buildSessionDescription } = SessionLibrary;
  const { fmtMinutes, parseDescriptionDurationMinutes } = Format;
  const { buildTrainingPlan } = PlanBuilder;

  // ── Helpers ────────────────────────────────────────────────────
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const addDaysIso = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const getMondayIso = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  };
  const fmtDateFR = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const fmtMonthFR = (year, month) => {
    const d = new Date(Date.UTC(year, month - 1, 1));
    return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
  const escHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const SPORT_ICONS = { Run: '🏃', Ride: '🚴', Swim: '🏊', Strength: '🏋️', Hike: '🥾', Walk: '🚶' };
  const sportIcon = (t) => SPORT_ICONS[t] || '🎽';

  // ── Default week templates ─────────────────────────────────────
  const DEFAULT_WEEK_TEMPLATES = [
    {
      id: 'light', name: 'Semaine légère', color: '#35c46f',
      sessions: [
        { dayOfWeek: 2, name: 'EF Footing', type: 'Run', rpe: 2, durationMin: 30 },
        { dayOfWeek: 4, name: 'EF Footing', type: 'Run', rpe: 2, durationMin: 30 },
        { dayOfWeek: 6, name: 'Sortie longue EF', type: 'Run', rpe: 2, durationMin: 60 },
      ],
    },
    {
      id: 'base', name: 'Semaine de base', color: '#4a90d9',
      sessions: [
        { dayOfWeek: 2, name: 'EF Footing', type: 'Run', rpe: 2, durationMin: 45 },
        { dayOfWeek: 3, name: 'Tempo', type: 'Run', rpe: 4, durationMin: 45 },
        { dayOfWeek: 5, name: 'EF Footing', type: 'Run', rpe: 2, durationMin: 45 },
        { dayOfWeek: 6, name: 'Sortie longue', type: 'Run', rpe: 3, durationMin: 90 },
      ],
    },
    {
      id: 'build', name: 'Semaine de charge', color: '#ff6b35',
      sessions: [
        { dayOfWeek: 2, name: 'EF Footing', type: 'Run', rpe: 2, durationMin: 45 },
        { dayOfWeek: 3, name: 'Seuil', type: 'Run', rpe: 5, durationMin: 60 },
        { dayOfWeek: 4, name: 'EF Récup', type: 'Run', rpe: 2, durationMin: 30 },
        { dayOfWeek: 5, name: 'VO2max', type: 'Run', rpe: 7, durationMin: 60 },
        { dayOfWeek: 6, name: 'Sortie longue', type: 'Run', rpe: 3, durationMin: 105 },
      ],
    },
    {
      id: 'recovery', name: 'Semaine récupération', color: '#9aa7c2',
      sessions: [
        { dayOfWeek: 2, name: 'EF Footing court', type: 'Run', rpe: 2, durationMin: 30 },
        { dayOfWeek: 4, name: 'EF Footing', type: 'Run', rpe: 2, durationMin: 45 },
        { dayOfWeek: 6, name: 'Sortie courte', type: 'Run', rpe: 2, durationMin: 45 },
      ],
    },
  ];

  let weekTemplates;
  try {
    weekTemplates = JSON.parse(localStorage.getItem('weekTemplates')) || JSON.parse(JSON.stringify(DEFAULT_WEEK_TEMPLATES));
  } catch (_) {
    weekTemplates = JSON.parse(JSON.stringify(DEFAULT_WEEK_TEMPLATES));
  }
  const saveTemplates = () => localStorage.setItem('weekTemplates', JSON.stringify(weekTemplates));

  // ── State ──────────────────────────────────────────────────────
  let athleteId = boot.athleteId || '0';
  let chronicData = boot.chronicData;
  let calendarCache = {}; // "YYYY-MM" -> [sessions] | null (loading)
  let pendingSessions = [];
  let selectedSession = null;
  const _today = new Date();
  let currentYear = _today.getFullYear();
  let currentMonth = _today.getMonth() + 1;
  let intervalsWorkouts = [];
  let sportFilter = '';
  let searchQuery = '';
  let pmcChart = null;
  let editingPendingId = null;
  let editingRealId = null;
  let pendingEdits = {}; // eventId (string) -> { date, name, type, description, moving_time, rpe, qualityKind, qualityParams }
  let pendingDeletes = new Set(); // Set<eventId (string)>
  let weekPlanState = {}; // weekIso -> { planningType, nRun, nBike, nStrength }

  const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

  if (boot.calendar && boot.calendar.length) {
    // boot.calendar vient d'une fenêtre glissante de 28 jours côté serveur (pas alignée sur le mois) :
    // ne garder que les dates du mois courant, sinon un mois voisin ensuite chargé séparément
    // (ex. pour l'horizon du graphique) ferait apparaitre ses séances en double dans allRealSessionsInCache.
    const monthStr = String(currentMonth).padStart(2, '0');
    calendarCache[monthKey(currentYear, currentMonth)] = boot.calendar.filter((s) => s.date && s.date.slice(5, 7) === monthStr && s.date.slice(0, 4) === String(currentYear));
  }

  function getMonthWeeks(year, month) {
    const firstIso = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastIso = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const weeks = [];
    let cur = getMondayIso(firstIso);
    while (cur <= lastIso) { weeks.push(cur); cur = addDaysIso(cur, 7); }
    return weeks;
  }

  // ── DOM refs ───────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    athleteSelect: $('athleteSelect'),
    intervalsLibrary: $('intervalsLibrary'),
    libSearch: $('librarySearch'),
    selPanel: $('selectedSessionPanel'),
    selName: $('selSessionName'),
    selMeta: $('selSessionMeta'),
    clearSel: $('clearSelection'),
    pendingBanner: $('pendingBanner'),
    pendingCount: $('pendingCount'),
    clearPendingBtn: $('clearPendingBtn'),
    sendPendingBtn: $('sendPendingBtn'),
    prevMonth: $('prevMonth'),
    nextMonth: $('nextMonth'),
    todayBtn: $('todayBtn'),
    monthLabel: $('monthLabel'),
    monthGrid: $('monthGrid'),
    nWeeks: $('nWeeks'),
    cycleSummary: $('cycleSummary'),
    weekTemplatesContainer: $('weekTemplatesContainer'),
    openTemplatesBtn: $('openTemplatesBtn'),
    templatesModal: $('templatesModal'),
    templatesClose: $('templatesClose'),
    sendResult: $('sendResult'),
    editModal: $('editModal'),
    editName: $('editName'),
    editRpe: $('editRpe'),
    editDescription: $('editDescription'),
    editComputedInfo: $('editComputedInfo'),
    editRealNotice: $('editRealNotice'),
    editSave: $('editSave'),
    editCancel: $('editCancel'),
    aiPlanModal: $('aiPlanModal'),
    aiPlanType: $('aiPlanType'),
    aiPlanAcwr: $('aiPlanAcwr'),
    aiPlanComment: $('aiPlanComment'),
    aiPlanCancel: $('aiPlanCancel'),
    aiPlanGenerate: $('aiPlanGenerate'),
    confirmSendModal: $('confirmSendModal'),
    confirmSendSummary: $('confirmSendSummary'),
    confirmSendCancel: $('confirmSendCancel'),
    confirmSendOk: $('confirmSendOk'),
  };

  // ── Library ────────────────────────────────────────────────────
  function renderLibrary() {
    const q = searchQuery.toLowerCase();
    const filterFn = (s) => {
      if (sportFilter && s.type !== sportFilter) return false;
      if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) return false;
      return true;
    };
    const list = intervalsWorkouts.filter(filterFn);
    el.intervalsLibrary.innerHTML = list.length
      ? list.map(workoutCardHtml).join('')
      : '<p class="caption" style="padding:10px 12px;">Aucun résultat.</p>';
    document.querySelectorAll('.workout-card').forEach((card) => {
      card.addEventListener('click', () => {
        const session = intervalsWorkouts.find((s) => s.id === card.dataset.id);
        if (session) selectSession(session, card);
      });
    });
  }

  function workoutCardHtml(s) {
    const dur = s.moving_time ? fmtMinutes(Math.round(s.moving_time / 60)) : '';
    const isSel = selectedSession && selectedSession.id === s.id;
    return `<div class="workout-card${isSel ? ' selected' : ''}" data-id="${escHtml(s.id)}" title="Cliquer pour sélectionner, puis cliquer un jour du calendrier">
      <div class="workout-card-header">
        <span class="workout-icon">${sportIcon(s.type)}</span>
        <span class="workout-name">${escHtml(s.name)}</span>
      </div>
      ${dur ? `<div class="workout-meta">${dur}${s.rpe ? ` · RPE ${s.rpe}` : ''}</div>` : ''}
    </div>`;
  }

  function selectSession(session, cardEl) {
    selectedSession = session;
    el.selPanel.style.display = 'block';
    el.selName.textContent = session.name;
    const dur = session.moving_time ? fmtMinutes(Math.round(session.moving_time / 60)) : '';
    el.selMeta.textContent = [sportIcon(session.type), session.type, dur, session.rpe ? `RPE ${session.rpe}` : ''].filter(Boolean).join(' · ');
    document.querySelectorAll('.workout-card.selected').forEach((c) => c.classList.remove('selected'));
    if (cardEl) cardEl.classList.add('selected');
    renderMonthCalendar(); // refresh droppable state
  }

  function clearSelection() {
    selectedSession = null;
    el.selPanel.style.display = 'none';
    document.querySelectorAll('.workout-card.selected').forEach((c) => c.classList.remove('selected'));
    renderMonthCalendar();
  }

  async function loadIntervalsWorkouts() {
    el.intervalsLibrary.innerHTML = '<div class="lib-loading"><div class="spinner"></div><span>Chargement…</span></div>';
    try {
      const res = await fetch(`/api/planning/workouts?athleteId=${encodeURIComponent(athleteId)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      intervalsWorkouts = (body.workouts || []).map((w) => {
        const TYPE_MAP = { WeightTraining: 'Strength', TrailRun: 'Run', VirtualRide: 'Ride', GravelRide: 'Ride', MountainBikeRide: 'Ride', OpenWaterSwim: 'Swim' };
        const type = TYPE_MAP[w.type] || w.type || 'Run';
        return {
          id: `intervals::${w.id}`,
          source: 'intervals',
          name: w.name || 'Sans nom',
          type,
          description: w.description || '',
          moving_time: w.moving_time || 0,
          rpe: null,
          intervals_id: w.id,
        };
      });
      renderLibrary();
    } catch (e) {
      el.intervalsLibrary.innerHTML = `<div class="alert alert-warning" style="margin:10px;">Bibliothèque Intervals.icu indisponible : ${escHtml(e.message)}</div>`;
    }
  }

  async function loadChronicData() {
    try {
      const params = new URLSearchParams({
        athleteId,
        historyStart: boot.historyStart || addDaysIso(todayIso(), -180),
        historyEnd: boot.historyEnd || todayIso(),
      });
      const res = await fetch(`/api/planning/chronic?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      chronicData = body.chronicData;
    } catch (_) {
      chronicData = null;
    }
    renderLoadChart();
  }

  // ── Month calendar ────────────────────────────────────────────
  async function fetchCalendarMonth(year, month) {
    const mk = monthKey(year, month);
    if (calendarCache[mk] !== undefined) return;
    calendarCache[mk] = null; // loading sentinel
    const mm = String(month).padStart(2, '0');
    const firstIso = `${year}-${mm}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastIso = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
    try {
      const res = await fetch(`/api/planning/calendar?athleteId=${encodeURIComponent(athleteId)}&start=${firstIso}&end=${lastIso}`);
      const body = await res.json();
      calendarCache[mk] = res.ok ? (body.calendar || []) : [];
    } catch (_) {
      calendarCache[mk] = [];
    }
    // Le graphique dépend aussi du cache calendrier (charge déjà planifiée sur les semaines futures) :
    // le rafraîchir ici, pas seulement la grille, sinon il resterait figé sur les données du chargement initial.
    refreshAll();
  }

  function dayCellHtml(date, inMonth, todayStr, canAdd) {
    const isToday = date === todayStr;
    const isPast = date < todayStr;
    const daySessions = realSessionsForDate(date);
    const dayPending = pendingSessions.filter((p) => p.date === date);
    const mk = monthKey(...date.split('-').slice(0, 2).map(Number));
    const loading = calendarCache[mk] === null;

    return `<div class="mcal-day${inMonth ? '' : ' outside'}${isToday ? ' today' : ''}${isPast ? ' past' : ''}${canAdd && inMonth ? ' droppable' : ''}" data-date="${date}">
      <div class="mcal-day-num${isToday ? ' today-badge' : ''}">${parseInt(date.slice(8), 10)}</div>
      <div class="mcal-sessions">
        ${loading && inMonth ? '<div class="chip-loading">…</div>' : ''}
        ${daySessions.map((s) => sessionChipHtml(s, 'real')).join('')}
        ${dayPending.map((s) => sessionChipHtml(s, 'pending')).join('')}
        ${!isPast && inMonth ? `<button class="plan-add-session" data-date="${date}">+ Séance</button>` : ''}
      </div>
    </div>`;
  }

  /** Barre d'actions au-dessus d'une semaine du calendrier (charge/ACWR prévu + préremplir/IA), affichée pour la semaine en cours et les semaines futures. */
  function weekActionsHtml(week) {
    const state = getWeekState(week);
    const metrics = weekMetrics(week);
    const acwrText = metrics.acwr == null ? 'n/a' : metrics.acwr.toFixed(2);
    const isCurrent = week === currentWeekIso();
    return `<div class="mcal-week-actions cycle-week-header" data-week="${week}">
      <div>
        <strong>Semaine du ${fmtDateFR(week)}${isCurrent ? ' (en cours)' : ''}</strong>
        <span class="caption">${Math.round(metrics.weeklyLoad)} Foster · ACWR ${acwrText}</span>
      </div>
      <div class="cycle-week-controls">
        <select class="cw-plan-type" data-week="${week}" title="Type de semaine">
          <option value="Charge"${state.planningType === 'Charge' ? ' selected' : ''}>Charge</option>
          <option value="Récupération"${state.planningType === 'Récupération' ? ' selected' : ''}>Récup</option>
          <option value="Choc"${state.planningType === 'Choc' ? ' selected' : ''}>Choc</option>
        </select>
        <input type="number" class="cw-run" data-week="${week}" min="0" max="8" value="${state.nRun}" title="Séances CAP" />
        <input type="number" class="cw-bike" data-week="${week}" min="0" max="8" value="${state.nBike}" title="Séances vélo" />
        <input type="number" class="cw-strength" data-week="${week}" min="0" max="6" value="${state.nStrength}" title="Séances renfo" />
        <button class="cw-prefill btn-sm" data-week="${week}">Préremplir</button>
        <button class="cw-ai-prefill btn-sm" data-week="${week}" title="Proposer une semaine via IA (Claude)">✨ IA</button>
      </div>
    </div>`;
  }

  function renderMonthCalendar() {
    const mk = monthKey(currentYear, currentMonth);
    if (calendarCache[mk] === undefined) fetchCalendarMonth(currentYear, currentMonth);
    const todayStr = todayIso();
    const monthStr = String(currentMonth).padStart(2, '0');
    const canAdd = !!selectedSession;

    el.monthLabel.textContent = fmtMonthFR(currentYear, currentMonth);

    const weeks = getMonthWeeks(currentYear, currentMonth);
    let html = `<div class="mcal-header">${DAYS_FR.map((d) => `<div class="mcal-dayname">${d}</div>`).join('')}</div>`;

    for (const monIso of weeks) {
      const weekEnd = addDaysIso(monIso, 6);
      const daysHtml = Array.from({ length: 7 }, (_, i) => dayCellHtml(addDaysIso(monIso, i), addDaysIso(monIso, i).slice(5, 7) === monthStr, todayStr, canAdd)).join('');
      if (weekEnd >= todayStr) {
        html += `<div class="mcal-week-block">${weekActionsHtml(monIso)}<div class="mcal-week">${daysHtml}</div></div>`;
      } else {
        html += `<div class="mcal-week">${daysHtml}</div>`;
      }
    }

    el.monthGrid.innerHTML = html;
  }

  /** Charge Foster = RPE × durée, comme pour les séances en attente. icu_training_load (autre métrique Intervals.icu, pas Foster) n'est utilisé qu'en dernier recours si l'événement n'a pas de RPE. */
  function realSessionLoad(s, durMin) {
    if (s.rpe && durMin) return Math.round(s.rpe * durMin);
    return Number.isFinite(s.trainingLoad) ? Math.round(s.trainingLoad) : null;
  }

  function sessionChipHtml(s, mode) {
    const icon = sportIcon(s.type || s.sport || '');
    const name = escHtml(s.name || s.seance || '');
    const durMin = s.moving_time ? Math.round(s.moving_time / 60) : (s.movingTime ? Math.round(s.movingTime / 60) : null);
    const dur = durMin ? fmtMinutes(durMin) : (s.temps || '');
    if (mode === 'pending') {
      const load = Math.round(pendingLoad(s));
      return `<div class="session-chip pending" draggable="true" data-pending-id="${escHtml(s.id)}" title="Glisser pour déplacer · cliquer pour modifier">
        <span>${icon} ${name}</span>
        ${s.qualityKind ? `<span class="chip-quality">${escHtml(s.qualityKind)}</span>` : ''}
        ${dur ? `<span class="chip-dur">${dur}</span>` : ''}
        <span class="chip-load">${load}</span>
        <button class="chip-remove" title="Supprimer">✕</button>
      </div>`;
    }
    const load = realSessionLoad(s, durMin);
    const cls = `session-chip real${s.edited ? ' edited' : ''}${s.toDelete ? ' to-delete' : ''}`;
    const draggable = !s.toDelete;
    return `<div class="${cls}" draggable="${draggable}" data-event-id="${escHtml(s.id)}" title="Glisser pour déplacer · cliquer pour modifier · ✕ pour ${s.toDelete ? 'annuler la suppression' : 'supprimer'} (confirmation demandée avant envoi)">
      <span>${icon} ${name}</span>
      ${dur ? `<span class="chip-dur">${dur}</span>` : ''}
      ${load != null ? `<span class="chip-load">${load}</span>` : ''}
      <button class="chip-remove" title="${s.toDelete ? 'Annuler la suppression' : 'Supprimer'}">${s.toDelete ? '↺' : '✕'}</button>
    </div>`;
  }

  /** Toutes les séances réelles (Intervals.icu) actuellement en cache, tous mois confondus, dédupliquées par id (au cas où deux mois en cache se chevaucheraient). */
  function allRealSessionsInCache() {
    const byId = new Map();
    const withoutId = [];
    for (const s of Object.values(calendarCache).filter(Array.isArray).flat()) {
      if (s.id == null) { withoutId.push(s); continue; }
      if (!byId.has(s.id)) byId.set(s.id, s);
    }
    return [...byId.values(), ...withoutId];
  }

  /** Séances réelles pour une date, en appliquant les modifications/suppressions en attente (non encore envoyées). */
  function realSessionsForDate(date) {
    return allRealSessionsInCache()
      .map((s) => {
        if (s.id == null) return s;
        const key = String(s.id);
        if (pendingDeletes.has(key)) return { ...s, toDelete: true };
        const edit = pendingEdits[key];
        return edit ? { ...s, ...edit, trainingLoad: null, edited: true } : s;
      })
      .filter((s) => s.date === date);
  }

  function movePendingSession(id, date) {
    const p = pendingSessions.find((s) => s.id === id);
    if (!p || !date || p.date === date) return;
    p.date = date;
    refreshAll();
  }

  /** Déplace une séance déjà envoyée sur Intervals.icu vers une autre date : reste en attente jusqu'à confirmation de l'envoi. */
  function moveRealSession(id, date) {
    const key = String(id);
    if (pendingDeletes.has(key)) return;
    const original = findRealSessionById(key);
    if (!original) return;
    const current = pendingEdits[key] || {
      name: original.name,
      type: original.type,
      rpe: original.rpe,
      description: original.description,
      moving_time: original.moving_time || original.movingTime || 0,
      date: original.date,
    };
    if (current.date === date) return;
    pendingEdits[key] = { ...current, date };
    refreshAll();
  }

  /** Câble le glisser-déposer entre jours (séances en attente et séances déjà sur Intervals.icu) vers les cellules de jour d'un conteneur. */
  function wireDragAndDrop(container, daySelector) {
    if (!container) return;
    container.addEventListener('dragstart', (e) => {
      const pendingChip = e.target.closest('.session-chip.pending');
      if (pendingChip) {
        e.dataTransfer.setData('text/plain', `pending:${pendingChip.dataset.pendingId}`);
        e.dataTransfer.effectAllowed = 'move';
        pendingChip.classList.add('dragging');
        return;
      }
      const realChip = e.target.closest('.session-chip.real[draggable="true"]');
      if (realChip && realChip.dataset.eventId) {
        e.dataTransfer.setData('text/plain', `real:${realChip.dataset.eventId}`);
        e.dataTransfer.effectAllowed = 'move';
        realChip.classList.add('dragging');
      }
    });
    container.addEventListener('dragend', (e) => {
      const chip = e.target.closest('.session-chip');
      if (chip) chip.classList.remove('dragging');
    });
    container.addEventListener('dragover', (e) => {
      const cell = e.target.closest(daySelector);
      if (!cell) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('drag-over');
    });
    container.addEventListener('dragleave', (e) => {
      const cell = e.target.closest(daySelector);
      if (cell) cell.classList.remove('drag-over');
    });
    container.addEventListener('drop', (e) => {
      const cell = e.target.closest(daySelector);
      if (!cell || !cell.dataset.date) return;
      e.preventDefault();
      cell.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      if (raw.startsWith('pending:')) {
        movePendingSession(raw.slice('pending:'.length), cell.dataset.date);
      } else if (raw.startsWith('real:')) {
        moveRealSession(raw.slice('real:'.length), cell.dataset.date);
      }
    });
  }

  function addPendingSession(date, session) {
    const src = session || selectedSession;
    if (!src) return;
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSessions.push({
      id,
      date,
      name: src.name,
      type: src.type,
      description: src.description || '',
      moving_time: src.moving_time || 0,
      rpe: src.rpe || 3,
    });
    refreshAll();
  }

  function addManualPlanSession(date) {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSessions.push({ id, date, name: 'Séance libre', type: 'Run', description: '- Séance libre 45m', moving_time: 45 * 60, rpe: 3 });
    refreshAll();
    openEditModal(id);
  }

  // ── Séances qualité (intervalles paramétrables, utilisées par le préremplissage automatique) ──
  /** Applique un template d'intervalles (bibliothèque) à une séance : régénère description/durée/RPE. */
  function applyQualityTemplate(p, type, kind) {
    const template = SESSION_LIBRARY[type] && SESSION_LIBRARY[type][kind];
    if (!template) return false;
    const { description, durationMin } = buildSessionDescription(template);
    p.type = type;
    p.qualityKind = kind;
    p.description = description;
    p.moving_time = Math.round(durationMin * 60);
    p.rpe = template.rpe || p.rpe || 5;
    p.name = `${type === 'Ride' ? 'Vélo' : 'CAP'} — ${kind}`;
    return true;
  }

  // ── Édition d'une séance : titre / RPE / description uniquement — la durée (et donc la charge
  // Foster) est toujours dérivée automatiquement de la description, seule source de vérité. ──
  /** Affiche en direct la durée/charge estimées à partir de la description + RPE saisis. */
  function updateEditComputedInfo() {
    const minutes = parseDescriptionDurationMinutes(el.editDescription.value);
    const rpe = Math.min(10, Math.max(1, parseInt(el.editRpe.value) || 3));
    el.editComputedInfo.textContent = minutes > 0
      ? `Durée estimée : ${fmtMinutes(minutes)} · Charge Foster : ${Math.round(minutes * rpe)}`
      : '⚠ Aucune durée reconnue dans la description — la durée précédente sera conservée.';
  }

  function fillEditForm(p) {
    el.editName.value = p.name;
    el.editRpe.value = p.rpe || 3;
    el.editDescription.value = p.description || '';
    updateEditComputedInfo();
  }

  function openEditModal(pendingId) {
    const p = pendingSessions.find((s) => s.id === pendingId);
    if (!p) return;
    editingPendingId = pendingId;
    editingRealId = null;
    fillEditForm(p);
    el.editRealNotice.style.display = 'none';
    el.editModal.style.display = 'flex';
  }

  /** Ouvre l'éditeur pour une séance déjà présente sur Intervals.icu : la modification reste en attente jusqu'à confirmation de l'envoi. */
  function openEditModalForReal(id) {
    const original = findRealSessionById(id);
    if (!original) return;
    editingRealId = String(id);
    editingPendingId = null;
    const staged = pendingEdits[editingRealId];
    const base = {
      name: original.name,
      date: original.date,
      type: original.type || 'Run',
      moving_time: original.moving_time || original.movingTime || 0,
      rpe: original.rpe || 3,
      description: original.description || '',
    };
    fillEditForm(staged || base);
    el.editRealNotice.style.display = 'block';
    el.editModal.style.display = 'flex';
  }

  function closeEditModal() {
    editingPendingId = null;
    editingRealId = null;
    el.editModal.style.display = 'none';
  }

  function saveEditModal() {
    const description = el.editDescription.value;
    const parsedMin = parseDescriptionDurationMinutes(description);
    const name = el.editName.value.trim() || 'Séance';
    const rpe = Math.min(10, Math.max(1, parseInt(el.editRpe.value) || 3));

    if (editingPendingId) {
      const p = pendingSessions.find((s) => s.id === editingPendingId);
      if (!p) return closeEditModal();
      const fallbackMin = Math.round((p.moving_time || 0) / 60) || 45;
      Object.assign(p, {
        name,
        rpe,
        description,
        moving_time: Math.round((parsedMin > 0 ? parsedMin : fallbackMin) * 60),
        qualityKind: null,
        qualityParams: null,
      });
    } else if (editingRealId) {
      const previous = pendingEdits[editingRealId] || findRealSessionById(editingRealId);
      if (!previous) return closeEditModal();
      const fallbackMin = Math.round((previous.moving_time || previous.movingTime || 0) / 60) || 45;
      pendingEdits[editingRealId] = {
        name,
        rpe,
        description,
        moving_time: Math.round((parsedMin > 0 ? parsedMin : fallbackMin) * 60),
        date: previous.date,
        type: previous.type,
      };
    }
    closeEditModal();
    refreshAll();
  }

  /** Toutes les séances réelles (Intervals.icu) actuellement en cache, tous mois confondus. */
  function findRealSessionById(id) {
    return allRealSessionsInCache().find((s) => String(s.id) === String(id));
  }

  /** Marque/démarque une séance réelle pour suppression (en attente de confirmation) ; annule toute modification en attente sur cette séance. */
  function toggleRealDelete(id) {
    const key = String(id);
    if (pendingDeletes.has(key)) {
      pendingDeletes.delete(key);
    } else {
      delete pendingEdits[key];
      pendingDeletes.add(key);
    }
    refreshAll();
  }

  /** Intervals.icu refuse un événement daté dans le passé : minuit est déjà passé pour "aujourd'hui". */
  function eventStartDateTime(dateIso) {
    if (dateIso !== todayIso()) return `${dateIso}T00:00:00`;
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + 1);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${dateIso}T${hh}:${mm}:00`;
  }

  function stagedCounts() {
    return { adds: pendingSessions.length, edits: Object.keys(pendingEdits).length, deletes: pendingDeletes.size };
  }

  function updatePendingBanner() {
    const { adds, edits, deletes } = stagedCounts();
    if (adds + edits + deletes === 0) {
      el.pendingBanner.style.display = 'none';
      return;
    }
    el.pendingBanner.style.display = 'flex';
    const parts = [];
    if (adds) parts.push(`${adds} à ajouter`);
    if (edits) parts.push(`${edits} à modifier`);
    if (deletes) parts.push(`${deletes} à supprimer`);
    el.pendingCount.textContent = parts.join(' · ');
  }

  function refreshAll() {
    updatePendingBanner();
    renderMonthCalendar();
    renderLoadChart();
  }

  // ── Confirmation puis envoi vers Intervals.icu ─────────────────
  function openConfirmSendModal() {
    const { adds, edits, deletes } = stagedCounts();
    if (adds + edits + deletes === 0) return;

    const addItems = pendingSessions.map((p) => `${sportIcon(p.type)} ${escHtml(p.name)} — ${fmtDateFR(p.date)}`);
    const editItems = Object.entries(pendingEdits).map(([id, d]) => {
      const original = findRealSessionById(id);
      const moved = original && original.date !== d.date ? ` (déplacée depuis ${fmtDateFR(original.date)})` : '';
      return `${sportIcon(d.type)} ${escHtml(d.name)} — ${fmtDateFR(d.date)}${moved}`;
    });
    const deleteItems = [...pendingDeletes].map((id) => {
      const original = findRealSessionById(id);
      return original ? `${sportIcon(original.type)} ${escHtml(original.name)} — ${fmtDateFR(original.date)}` : `séance #${escHtml(id)}`;
    });

    const section = (title, items) => (items.length
      ? `<p><strong>${title} (${items.length})</strong></p><ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`
      : '');

    el.confirmSendSummary.innerHTML =
      section('➕ Séances à ajouter', addItems) +
      section('✎ Séances à modifier', editItems) +
      section('🗑 Séances à supprimer', deleteItems);

    el.confirmSendModal.style.display = 'flex';
  }

  function closeConfirmSendModal() {
    el.confirmSendModal.style.display = 'none';
  }

  /** Envoie effectivement les ajouts/modifications/suppressions en attente vers Intervals.icu — appelé uniquement après confirmation explicite. */
  async function confirmSend() {
    closeConfirmSendModal();
    el.sendPendingBtn.disabled = true;
    el.sendResult.innerHTML = '<div class="alert alert-info">Envoi en cours…</div>';

    const touchedMonths = new Set();
    let okCount = 0;
    const errors = [];

    if (pendingSessions.length) {
      const events = pendingSessions.map((p) => ({
        start_date_local: eventStartDateTime(p.date),
        category: 'WORKOUT',
        type: p.type,
        name: p.name,
        description: p.description,
        moving_time: Math.round(p.moving_time),
        icu_rpe: Math.round(p.rpe),
        external_id: `dashboard-${p.id}`,
      }));
      try {
        const res = await fetch('/api/planning/send-bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ athleteId, events, confirmed: true }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Échec de l'envoi des nouvelles séances.");
        okCount += pendingSessions.length;
        pendingSessions.forEach((p) => touchedMonths.add(p.date.slice(0, 7)));
        pendingSessions = [];
      } catch (e) {
        errors.push(e.message);
      }
    }

    for (const [id, data] of Object.entries(pendingEdits)) {
      try {
        const res = await fetch(`/api/planning/event/${encodeURIComponent(id)}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            athleteId,
            confirmed: true,
            patch: {
              start_date_local: eventStartDateTime(data.date),
              type: data.type,
              name: data.name,
              description: data.description,
              moving_time: Math.round(data.moving_time),
              icu_rpe: Math.round(data.rpe),
            },
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Échec de la modification de la séance #${id}.`);
        okCount++;
        touchedMonths.add(data.date.slice(0, 7));
        delete pendingEdits[id];
      } catch (e) {
        errors.push(e.message);
      }
    }

    for (const id of [...pendingDeletes]) {
      try {
        const res = await fetch(`/api/planning/event/${encodeURIComponent(id)}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ athleteId, confirmed: true }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Échec de la suppression de la séance #${id}.`);
        okCount++;
        pendingDeletes.delete(id);
      } catch (e) {
        errors.push(e.message);
      }
    }

    touchedMonths.forEach((mk) => { delete calendarCache[mk]; });
    if (errors.length) {
      el.sendResult.innerHTML = `<div class="alert alert-error">${okCount} action(s) envoyée(s), ${errors.length} erreur(s) : ${escHtml(errors.join(' · '))}</div>`;
    } else {
      el.sendResult.innerHTML = `<div class="alert alert-success">✅ ${okCount} action(s) envoyée(s) avec succès dans Intervals.icu.</div>`;
    }
    el.sendPendingBtn.disabled = false;
    refreshAll();
  }

  // ── Charge & ACWR prévisionnels ─────────────────────────────────
  function pendingLoad(p) {
    return (p.rpe || 3) * Math.round((p.moving_time || 0) / 60);
  }

  function currentWeekIso() {
    return getMondayIso(todayIso());
  }

  function weeksBetween(aIso, bIso) {
    const a = new Date(aIso + 'T00:00:00Z').getTime();
    const b = new Date(bIso + 'T00:00:00Z').getTime();
    return Math.round((b - a) / (7 * 86400000));
  }

  function getPlanWeeks(nWeeks) {
    const first = currentWeekIso();
    return Array.from({ length: nWeeks }, (_, i) => addDaysIso(first, i * 7));
  }

  function getPendingInWeek(weekStart) {
    const weekEnd = addDaysIso(weekStart, 6);
    return pendingSessions.filter((p) => p.date >= weekStart && p.date <= weekEnd);
  }

  function weekPendingLoad(weekStart) {
    return getPendingInWeek(weekStart).reduce((s, p) => s + pendingLoad(p), 0);
  }

  /** Charge réelle (Intervals.icu) d'une semaine (WORKOUT/PLAN déjà envoyés), modifs/suppressions en attente appliquées. */
  function weekRealLoad(weekStart) {
    const weekEnd = addDaysIso(weekStart, 6);
    return allRealSessionsInCache()
      .map((s) => {
        if (s.id == null) return s;
        const key = String(s.id);
        if (pendingDeletes.has(key)) return null;
        const edit = pendingEdits[key];
        return edit ? { ...s, ...edit, trainingLoad: null } : s;
      })
      .filter((s) => s && s.date >= weekStart && s.date <= weekEnd)
      .reduce((sum, s) => {
        const durMin = s.moving_time ? Math.round(s.moving_time / 60) : (s.movingTime ? Math.round(s.movingTime / 60) : null);
        return sum + (realSessionLoad(s, durMin) || 0);
      }, 0);
  }

  /** Ajuste le total serveur (déjà testé) de la semaine en cours avec les modifs/suppressions en attente, pour un affichage en direct. */
  function currentWeekStagedDelta() {
    const touchedIds = new Set([...Object.keys(pendingEdits), ...pendingDeletes]);
    if (!touchedIds.size) return 0;
    const weekStart = currentWeekIso();
    const weekEnd = addDaysIso(weekStart, 6);
    let delta = 0;
    for (const s of allRealSessionsInCache()) {
      if (s.id == null || !touchedIds.has(String(s.id))) continue;
      const key = String(s.id);
      const durMin = s.moving_time ? Math.round(s.moving_time / 60) : (s.movingTime ? Math.round(s.movingTime / 60) : null);
      const rawLoad = realSessionLoad(s, durMin) || 0;
      const inWeekOriginal = s.date >= weekStart && s.date <= weekEnd;
      if (pendingDeletes.has(key)) {
        if (inWeekOriginal) delta -= rawLoad;
        continue;
      }
      const edit = pendingEdits[key];
      if (edit) {
        const editedDurMin = edit.moving_time ? Math.round(edit.moving_time / 60) : durMin;
        const newLoad = realSessionLoad({ ...s, ...edit, trainingLoad: null }, editedDurMin) || 0;
        const inWeekNew = edit.date >= weekStart && edit.date <= weekEnd;
        if (inWeekOriginal) delta -= rawLoad;
        if (inWeekNew) delta += newLoad;
      }
    }
    return delta;
  }

  /**
   * Charge totale d'une semaine pour l'ACWR prévisionnel : pour la semaine en cours, projection
   * "pure plan" (charge déjà planifiée sur Intervals.icu pour toute la semaine + séances en attente
   * non envoyées), sans mélanger le réel déjà fait — même logique que le dashboard. Pour les semaines
   * futures : charge déjà envoyée sur Intervals.icu (calendrier en cache) + séances en attente. Le
   * tout ajusté en direct par les modifications/suppressions en attente.
   */
  function weekTotalLoad(week) {
    if (week === currentWeekIso()) {
      const plannedTotal = (chronicData && chronicData.currentWeekPlannedTotal) || 0;
      return Math.max(0, plannedTotal + currentWeekStagedDelta() + weekPendingLoad(week));
    }
    return weekRealLoad(week) + weekPendingLoad(week);
  }

  /** Semaines réalisées : uniquement les 4 dernières (fenêtre de calcul de la charge chronique), pour ne pas surcharger le graphique. */
  function historicalWeeklyLoads() {
    const hist = chronicData && Array.isArray(chronicData.weeklyHistory) ? chronicData.weeklyHistory : [];
    return hist
      .filter((w) => Number.isFinite(Number(w.weekly_load)))
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-4)
      .map((w) => ({ week: w.week, load: Number(w.weekly_load), acwr: w.acwr }));
  }

  function chronicBeforeWeek(weekStart) {
    const loads = historicalWeeklyLoads().map((w) => w.load);
    const span = Math.max(16, weeksBetween(currentWeekIso(), weekStart) + 1);
    for (const week of getPlanWeeks(span)) {
      if (week >= weekStart) break;
      loads.push(weekTotalLoad(week));
    }
    const windowVals = loads.slice(-4);
    if (windowVals.length >= 3) return windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
    return chronicData ? chronicData.chronic : 0;
  }

  /** Charge/ACWR prévu d'une semaine quelconque — utilisé par la barre d'actions du calendrier. */
  function weekMetrics(week) {
    const chronic = chronicBeforeWeek(week);
    const weeklyLoad = weekTotalLoad(week);
    const acwr = chronic > 0 ? weeklyLoad / chronic : null;
    return { weeklyLoad, chronic, acwr };
  }

  function projectWeeklyAcwr(planWeeks) {
    const loads = historicalWeeklyLoads().map((w) => w.load);
    return planWeeks.map((week) => {
      const weeklyLoad = weekTotalLoad(week);
      const windowVals = loads.slice(-4);
      const chronic = windowVals.length >= 3 ? windowVals.reduce((s, v) => s + v, 0) / windowVals.length : 0;
      const acwr = chronic > 0 ? weeklyLoad / chronic : null;
      loads.push(weeklyLoad);
      return { week, weeklyLoad, chronic, acwr, isCurrentWeek: week === currentWeekIso() };
    });
  }

  function getWeekState(week) {
    if (!weekPlanState[week]) weekPlanState[week] = { planningType: 'Charge', nRun: 3, nBike: 1, nStrength: 1 };
    return weekPlanState[week];
  }

  /** Choisit une date libre dans la semaine, en respectant l'ordre de préférence et en évitant le passé pour la semaine en cours. */
  function pickSessionDate(weekStart, preferredDows, usedDates) {
    const minDate = weekStart === currentWeekIso() ? todayIso() : weekStart;
    const ordered = preferredDows.map((dow) => addDaysIso(weekStart, dow - 1));
    let date = ordered.find((d) => d >= minDate && !usedDates.has(d));
    if (!date) {
      for (let i = 0; i < 7; i++) {
        const d = addDaysIso(weekStart, i);
        if (d >= minDate && !usedDates.has(d)) { date = d; break; }
      }
    }
    if (!date) date = ordered[0] || weekStart;
    usedDates.add(date);
    return date;
  }

  function applyGeneratedPlanWeek(week) {
    const state = getWeekState(week);
    const chronicLoad = chronicBeforeWeek(week);
    const plan = buildTrainingPlan({ chronicLoad, planningType: state.planningType, nRun: state.nRun, nBike: state.nBike, nStrength: state.nStrength });
    const preferredDays = {
      Run: [2, 4, 6, 7, 3, 5, 1],
      Ride: [3, 5, 7, 2, 4, 6, 1],
      Strength: [1, 5, 3, 2, 4, 6, 7],
    };
    const usedBySport = { Run: new Set(), Ride: new Set(), Strength: new Set() };
    const weekEnd = addDaysIso(week, 6);
    pendingSessions = pendingSessions.filter((p) => p.date < week || p.date > weekEnd);

    for (const s of plan.sessions) {
      const type = s.sport === 'CAP' ? 'Run' : s.sport === 'Vélo' ? 'Ride' : 'Strength';
      const date = pickSessionDate(week, preferredDays[type], usedBySport[type]);
      const pending = {
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        date,
        name: s.seance,
        type,
        description: '',
        moving_time: s.dureeMin * 60,
        rpe: s.rpe,
      };
      // Par défaut, la séance de qualité utilise un vrai template d'intervalles (paramétrable ensuite).
      if (s.seance === 'CAP — qualité') applyQualityTemplate(pending, 'Run', 'Seuil');
      pendingSessions.push(pending);
    }

    refreshAll();
  }

  /** ACWR cible par défaut proposé selon le type de semaine (éditable ensuite par l'utilisateur). */
  function defaultTargetAcwrFor(planningType) {
    if (planningType === 'Choc') return 1.5;
    if (planningType === 'Récupération') return 0.7;
    return 1.15; // Charge
  }

  let aiPlanTargetWeek = null;

  /** Ouvre la modale de proposition IA : laisse choisir le type de semaine, l'ACWR cible et un commentaire libre. */
  function openAiPlanModal(week) {
    aiPlanTargetWeek = week;
    const state = getWeekState(week);
    el.aiPlanType.value = state.planningType;
    el.aiPlanAcwr.value = defaultTargetAcwrFor(state.planningType);
    el.aiPlanComment.value = '';
    el.aiPlanModal.style.display = 'flex';
  }

  function closeAiPlanModal() {
    aiPlanTargetWeek = null;
    el.aiPlanModal.style.display = 'none';
  }

  /** Propose une semaine via l'IA (Claude) : charge chronique + type de semaine choisi + ACWR cible + commentaire libre. */
  async function applyAiPlanWeek(week, { planningType, targetAcwr, comment }) {
    const state = getWeekState(week);
    state.planningType = planningType;
    const btn = el.monthGrid && el.monthGrid.querySelector(`.cw-ai-prefill[data-week="${week}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ IA…'; }

    try {
      const res = await fetch('/api/planning/ai-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          week,
          planningType,
          nRun: state.nRun,
          nBike: state.nBike,
          nStrength: state.nStrength,
          chronicLoad: chronicBeforeWeek(week),
          targetAcwr,
          constraints: '',
          comment,
          recentWeeks: historicalWeeklyLoads().map((w) => ({ week: w.week, load: Math.round(w.load) })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Échec de la proposition IA.");

      const weekEnd = addDaysIso(week, 6);
      pendingSessions = pendingSessions.filter((p) => p.date < week || p.date > weekEnd);

      for (const s of body.plan.sessions) {
        pendingSessions.push({
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          date: addDaysIso(week, s.dayOfWeek - 1),
          name: s.name,
          type: s.sport,
          description: s.description || '',
          moving_time: s.durationMin * 60,
          rpe: s.rpe,
        });
      }

      refreshAll();
      if (body.plan.rationale && el.sendResult) {
        el.sendResult.innerHTML = `<div class="alert alert-info">🤖 ${escHtml(body.plan.rationale)}</div>`;
      }
    } catch (e) {
      if (el.sendResult) el.sendResult.innerHTML = `<div class="alert alert-error">Erreur IA : ${escHtml(e.message)}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = '✨ IA'; }
    }
  }

  /** Précharge (best-effort) les mois couverts par l'horizon du graphique, pour que la charge déjà envoyée sur les semaines futures apparaisse dans le graphique et les barres d'action du calendrier. */
  function prefetchHorizonMonths(planWeeks) {
    const keys = new Set();
    for (const week of planWeeks) {
      [week, addDaysIso(week, 6)].forEach((d) => keys.add(`${d.slice(0, 4)}-${d.slice(5, 7)}`));
    }
    keys.forEach((mk) => {
      if (calendarCache[mk] === undefined) {
        const [y, m] = mk.split('-').map(Number);
        fetchCalendarMonth(y, m);
      }
    });
  }

  async function renderLoadChart() {
    if (!window.Chart) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    const nWeeks = parseInt(el.nWeeks.value) || 8;
    const planWeeks = getPlanWeeks(nWeeks);
    prefetchHorizonMonths(planWeeks); // best-effort ; fetchCalendarMonth rafraîchira tout à réception
    // Semaines réalisées (4 dernières max) : point de départ "comme si rien n'était encore planifié".
    const realized = historicalWeeklyLoads();
    const nRealized = realized.length;
    const projection = projectWeeklyAcwr(planWeeks);

    const latestReal = realized[nRealized - 1];
    if (el.cycleSummary) {
      const parts = [];
      if (latestReal) parts.push(`Dernière semaine réalisée : ${fmtDateFR(latestReal.week)} · ${Math.round(latestReal.load)} Foster`);
      if (chronicData && chronicData.currentWeekActual) parts.push(`Semaine en cours (réel à date) : ${Math.round(chronicData.currentWeekActual.weekly_load)} Foster`);
      el.cycleSummary.textContent = parts.join(' · ') || 'Historique réalisé indisponible.';
    }

    const timelineWeeks = [...realized.map((w) => w.week), ...planWeeks];
    const labels = timelineWeeks.map((w) => fmtDateFR(w));

    // Barres empilées "réel" (réalisé + partiel semaine en cours) / "planifié" (séances en attente),
    // mises à jour en direct à chaque ajout/retrait de séance en attente.
    const realBars = timelineWeeks.map((week, i) => {
      if (i < nRealized) return Math.round(realized[i].load);
      if (week === currentWeekIso() && chronicData && chronicData.currentWeekActual && chronicData.currentWeekActual.week === week) {
        return Math.round(chronicData.currentWeekActual.weekly_load || 0);
      }
      return 0;
    });
    const plannedBars = timelineWeeks.map((week, i) => {
      if (i < nRealized) return 0;
      if (week === currentWeekIso()) return Math.round(weekPendingLoad(week));
      return Math.round(weekTotalLoad(week));
    });

    const acwrReal = timelineWeeks.map((_, i) => (i < nRealized && realized[i].acwr != null ? parseFloat(realized[i].acwr.toFixed(2)) : null));
    const acwrForecast = timelineWeeks.map((_, i) => {
      if (i < nRealized) return null;
      const p = projection[i - nRealized];
      return p.acwr == null ? null : parseFloat(p.acwr.toFixed(2));
    });

    const maxStack = timelineWeeks.length ? Math.max(...timelineWeeks.map((_, i) => realBars[i] + plannedBars[i])) : 0;

    if (pmcChart) pmcChart.destroy();
    const ctx = $('pmc_chart').getContext('2d');
    pmcChart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Charge réelle',
            data: realBars,
            backgroundColor: 'rgba(53,196,111,0.55)',
            stack: 'weeklyLoad',
            yAxisID: 'yLoad',
            order: -1,
          },
          {
            type: 'bar',
            label: 'Charge planifiée',
            data: plannedBars,
            backgroundColor: 'rgba(245,166,35,0.45)',
            stack: 'weeklyLoad',
            yAxisID: 'yLoad',
            order: -1,
          },
          {
            type: 'line',
            label: '',
            data: labels.map(() => 1.0),
            borderColor: '#666',
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            order: 10,
          },
          {
            type: 'line',
            label: 'Zone 1,0 – 1,3',
            data: labels.map(() => 1.3),
            borderColor: '#666',
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            backgroundColor: 'rgba(53,196,111,0.12)',
            fill: '-1',
            order: 10,
          },
          {
            type: 'line',
            label: 'ACWR',
            data: acwrReal,
            borderColor: '#4a90d9',
            borderWidth: 3,
            pointRadius: 3,
            spanGaps: true,
          },
          {
            type: 'line',
            label: 'ACWR prévisionnel',
            data: acwrForecast,
            borderColor: '#f5a623',
            borderDash: [6, 4],
            borderWidth: 2,
            pointStyle: 'circle',
            pointRadius: 4,
            pointBackgroundColor: 'transparent',
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          if (idx < nRealized) return;
          goToWeek(planWeeks[idx - nRealized]);
        },
        plugins: {
          legend: { labels: { color: '#9aa7c2', filter: (item) => item.text !== '' } },
          tooltip: {
            mode: 'index',
            callbacks: {
              label: (item) => {
                if (item.dataset.label === 'Charge réelle' || item.dataset.label === 'Charge planifiée') {
                  return `${item.dataset.label} : ${Math.round(item.raw || 0)}`;
                }
                return `${item.dataset.label} : ${item.raw != null ? item.raw.toFixed(2) : '—'}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#9aa7c2' }, grid: { color: '#2a3348' } },
          y: {
            title: { display: true, text: 'ACWR', color: '#9aa7c2' },
            min: 0, max: 2,
            ticks: { color: '#9aa7c2' }, grid: { color: '#2a3348' },
          },
          yLoad: {
            stacked: true,
            position: 'right',
            beginAtZero: true,
            max: maxStack > 0 ? maxStack * 3 : undefined,
            title: { display: true, text: 'Charge Foster / semaine', color: '#9aa7c2' },
            ticks: { color: '#9aa7c2' },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });

  }

  /** Navigue le calendrier vers le mois d'une semaine donnée et met en évidence sa barre d'actions (utilisé par le clic sur le graphique et par l'application d'un template). */
  function goToWeek(week) {
    const weekDate = new Date(week + 'T00:00:00Z');
    currentYear = weekDate.getUTCFullYear();
    currentMonth = weekDate.getUTCMonth() + 1;
    renderMonthCalendar();
    fetchCalendarMonth(currentYear, currentMonth);
    requestAnimationFrame(() => {
      const bar = el.monthGrid.querySelector(`.mcal-week-actions[data-week="${week}"]`);
      if (!bar) return;
      bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
      bar.classList.add('flash');
      setTimeout(() => bar.classList.remove('flash'), 1400);
    });
  }

  // ── Week templates ─────────────────────────────────────────────
  function renderWeekTemplates() {
    const container = el.weekTemplatesContainer;
    if (!container) return;

    container.innerHTML = weekTemplates.map((tpl, tIdx) => {
      const daysGrid = DAYS_FR.map((dayName, di) => {
        const dow = di + 1;
        const daySessions = tpl.sessions.filter((s) => s.dayOfWeek === dow);
        const chips = daySessions.map((s, sIdx) =>
          `<div class="tpl-chip">
            <span>${sportIcon(s.type)} ${escHtml(s.name)}</span>
            <span class="tpl-chip-meta">${s.durationMin}min · RPE ${s.rpe}</span>
            <div class="tpl-chip-actions">
              <button class="tpl-chip-edit" data-tpl="${tIdx}" data-session="${sIdx}" title="Modifier">✎</button>
              <button class="tpl-chip-remove" data-tpl="${tIdx}" data-session="${sIdx}" title="Supprimer">✕</button>
            </div>
          </div>`
        ).join('');
        return `<div class="tpl-day">
          <div class="tpl-day-name">${dayName}</div>
          ${chips}
          <button class="tpl-add-session" data-tpl="${tIdx}" data-dow="${dow}" title="Ajouter">+</button>
        </div>`;
      }).join('');

      const load = tpl.sessions.reduce((s, x) => s + x.rpe * x.durationMin, 0);

      return `<div class="tpl-card" style="border-top:3px solid ${escHtml(tpl.color)};">
        <div class="tpl-card-header">
          <input class="tpl-name-input" data-tpl="${tIdx}" value="${escHtml(tpl.name)}" />
          <span class="tpl-load-badge">~${load} Foster</span>
          <div class="tpl-apply-row">
            <label>Appliquer à partir du</label>
            <input type="date" class="tpl-apply-date" data-tpl="${tIdx}" value="${getMondayIso(todayIso())}" />
            <button class="tpl-apply-btn btn-sm" data-tpl="${tIdx}">Planifier →</button>
          </div>
        </div>
        <div class="tpl-days-grid">${daysGrid}</div>
      </div>`;
    }).join('');

    container.querySelectorAll('.tpl-name-input').forEach((inp) => {
      inp.addEventListener('change', () => { weekTemplates[+inp.dataset.tpl].name = inp.value; saveTemplates(); });
    });
    container.querySelectorAll('.tpl-apply-btn').forEach((btn) => {
      btn.addEventListener('click', () => applyWeekTemplate(+btn.dataset.tpl));
    });
    container.querySelectorAll('.tpl-chip-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        weekTemplates[+btn.dataset.tpl].sessions.splice(+btn.dataset.session, 1);
        saveTemplates();
        renderWeekTemplates();
      });
    });
    container.querySelectorAll('.tpl-chip-edit').forEach((btn) => {
      btn.addEventListener('click', () => openTplSessionEditor(+btn.dataset.tpl, +btn.dataset.session, null));
    });
    container.querySelectorAll('.tpl-add-session').forEach((btn) => {
      btn.addEventListener('click', () => openTplSessionEditor(+btn.dataset.tpl, null, +btn.dataset.dow));
    });
  }

  function applyWeekTemplate(tplIdx) {
    const tpl = weekTemplates[tplIdx];
    const dateInput = el.weekTemplatesContainer.querySelector(`.tpl-apply-date[data-tpl="${tplIdx}"]`);
    const weekStart = getMondayIso(dateInput ? dateInput.value : todayIso());
    for (const s of tpl.sessions) {
      const date = addDaysIso(weekStart, s.dayOfWeek - 1);
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingSessions.push({ id, date, name: s.name, type: s.type, description: '', moving_time: s.durationMin * 60, rpe: s.rpe });
    }
    el.templatesModal.style.display = 'none';
    refreshAll();
    goToWeek(weekStart);
  }

  function openTplSessionEditor(tplIdx, sessionIdx, dow) {
    const modal = $('tplSessionModal');
    const isNew = sessionIdx === null;
    const tpl = weekTemplates[tplIdx];
    const s = isNew ? { dayOfWeek: dow || 1, name: '', type: 'Run', rpe: 3, durationMin: 45 } : tpl.sessions[sessionIdx];
    $('tplSessName').value = s.name;
    $('tplSessType').value = s.type;
    $('tplSessDow').value = s.dayOfWeek;
    $('tplSessRpe').value = s.rpe;
    $('tplSessDuration').value = s.durationMin;
    modal.dataset.tpl = tplIdx;
    modal.dataset.session = isNew ? 'new' : String(sessionIdx);
    modal.style.display = 'flex';
  }

  // ── Event wiring ──────────────────────────────────────────────

  if (el.athleteSelect) {
    el.athleteSelect.addEventListener('change', () => {
      athleteId = el.athleteSelect.value;
      calendarCache = {};
      intervalsWorkouts = [];
      pendingSessions = [];
      pendingEdits = {};
      pendingDeletes.clear();
      loadIntervalsWorkouts();
      loadChronicData();
      fetchCalendarMonth(currentYear, currentMonth);
      refreshAll();
    });
  }

  el.libSearch.addEventListener('input', () => { searchQuery = el.libSearch.value; renderLibrary(); });

  document.querySelectorAll('.sport-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.sport-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      sportFilter = pill.dataset.sport;
      renderLibrary();
    });
  });

  el.clearSel.addEventListener('click', clearSelection);
  el.clearPendingBtn.addEventListener('click', () => {
    pendingSessions = [];
    pendingEdits = {};
    pendingDeletes.clear();
    refreshAll();
  });
  el.sendPendingBtn.addEventListener('click', openConfirmSendModal);
  el.confirmSendCancel.addEventListener('click', closeConfirmSendModal);
  el.confirmSendModal.addEventListener('click', (e) => { if (e.target === el.confirmSendModal) closeConfirmSendModal(); });
  el.confirmSendOk.addEventListener('click', confirmSend);

  el.openTemplatesBtn.addEventListener('click', () => {
    renderWeekTemplates();
    el.templatesModal.style.display = 'flex';
  });
  el.templatesClose.addEventListener('click', () => { el.templatesModal.style.display = 'none'; });
  el.templatesModal.addEventListener('click', (e) => { if (e.target === el.templatesModal) el.templatesModal.style.display = 'none'; });

  el.prevMonth.addEventListener('click', () => {
    currentMonth--; if (currentMonth < 1) { currentMonth = 12; currentYear--; }
    renderMonthCalendar(); fetchCalendarMonth(currentYear, currentMonth);
  });
  el.nextMonth.addEventListener('click', () => {
    currentMonth++; if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    renderMonthCalendar(); fetchCalendarMonth(currentYear, currentMonth);
  });
  el.todayBtn.addEventListener('click', () => {
    const d = new Date(); currentYear = d.getFullYear(); currentMonth = d.getMonth() + 1;
    renderMonthCalendar(); fetchCalendarMonth(currentYear, currentMonth);
  });

  // Calendrier : semaine (préremplir/IA/paramètres), séances (ajout/édition/suppression)
  el.monthGrid.addEventListener('change', (e) => {
    const week = e.target.dataset.week;
    if (!week) return;
    const state = getWeekState(week);
    if (e.target.classList.contains('cw-plan-type')) state.planningType = e.target.value;
    else if (e.target.classList.contains('cw-run')) state.nRun = Math.max(0, parseInt(e.target.value) || 0);
    else if (e.target.classList.contains('cw-bike')) state.nBike = Math.max(0, parseInt(e.target.value) || 0);
    else if (e.target.classList.contains('cw-strength')) state.nStrength = Math.max(0, parseInt(e.target.value) || 0);
  });

  el.monthGrid.addEventListener('click', (e) => {
    const prefillBtn = e.target.closest('.cw-prefill');
    if (prefillBtn) { applyGeneratedPlanWeek(prefillBtn.dataset.week); return; }

    const aiBtn = e.target.closest('.cw-ai-prefill');
    if (aiBtn) { openAiPlanModal(aiBtn.dataset.week); return; }

    const removeBtn = e.target.closest('.chip-remove');
    if (removeBtn) {
      const chip = removeBtn.closest('.session-chip');
      if (chip && chip.dataset.pendingId) {
        pendingSessions = pendingSessions.filter((p) => p.id !== chip.dataset.pendingId);
        refreshAll();
      } else if (chip && chip.dataset.eventId) {
        toggleRealDelete(chip.dataset.eventId);
      }
      return;
    }

    const pendingChip = e.target.closest('.session-chip.pending');
    if (pendingChip && pendingChip.dataset.pendingId) { openEditModal(pendingChip.dataset.pendingId); return; }

    const realChip = e.target.closest('.session-chip.real');
    if (realChip && realChip.dataset.eventId) { openEditModalForReal(realChip.dataset.eventId); return; }

    const addBtn = e.target.closest('.plan-add-session');
    if (addBtn) { addManualPlanSession(addBtn.dataset.date); return; }

    const dayCell = e.target.closest('.mcal-day:not(.outside)');
    if (dayCell && selectedSession) addPendingSession(dayCell.dataset.date);
  });

  el.editSave.addEventListener('click', saveEditModal);
  el.editCancel.addEventListener('click', closeEditModal);
  el.editModal.addEventListener('click', (e) => { if (e.target === el.editModal) closeEditModal(); });
  el.editDescription.addEventListener('input', updateEditComputedInfo);
  el.editRpe.addEventListener('input', updateEditComputedInfo);

  if (el.nWeeks) el.nWeeks.addEventListener('change', renderLoadChart);

  el.aiPlanType.addEventListener('change', () => { el.aiPlanAcwr.value = defaultTargetAcwrFor(el.aiPlanType.value); });
  el.aiPlanCancel.addEventListener('click', closeAiPlanModal);
  el.aiPlanModal.addEventListener('click', (e) => { if (e.target === el.aiPlanModal) closeAiPlanModal(); });
  el.aiPlanGenerate.addEventListener('click', () => {
    if (!aiPlanTargetWeek) return;
    const week = aiPlanTargetWeek;
    const planningType = el.aiPlanType.value;
    const targetAcwr = parseFloat(el.aiPlanAcwr.value) || defaultTargetAcwrFor(planningType);
    const comment = el.aiPlanComment.value.trim();
    closeAiPlanModal();
    applyAiPlanWeek(week, { planningType, targetAcwr, comment });
  });

  wireDragAndDrop(el.monthGrid, '.mcal-day:not(.outside)');

  const tplSessionModal = $('tplSessionModal');
  $('tplSessSave').addEventListener('click', () => {
    const tplIdx = +tplSessionModal.dataset.tpl;
    const sessionIdx = tplSessionModal.dataset.session;
    const s = {
      dayOfWeek: parseInt($('tplSessDow').value),
      name: $('tplSessName').value.trim() || 'Séance',
      type: $('tplSessType').value,
      rpe: parseInt($('tplSessRpe').value) || 3,
      durationMin: parseInt($('tplSessDuration').value) || 30,
    };
    if (sessionIdx === 'new') {
      weekTemplates[tplIdx].sessions.push(s);
    } else {
      weekTemplates[tplIdx].sessions[+sessionIdx] = s;
    }
    weekTemplates[tplIdx].sessions.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
    saveTemplates();
    tplSessionModal.style.display = 'none';
    renderWeekTemplates();
  });
  $('tplSessCancel').addEventListener('click', () => { tplSessionModal.style.display = 'none'; });
  tplSessionModal.addEventListener('click', (e) => { if (e.target === tplSessionModal) tplSessionModal.style.display = 'none'; });

  // ── Init ──────────────────────────────────────────────────────
  renderLibrary();
  loadIntervalsWorkouts();
  renderMonthCalendar();
  fetchCalendarMonth(currentYear, currentMonth);
  renderLoadChart();

})();
