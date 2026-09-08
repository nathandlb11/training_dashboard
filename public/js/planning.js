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
  const { fmtMinutes } = Format;
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
  let weekPlanState = {}; // weekIso -> { planningType, nRun, nBike, nStrength }
  let cycleNotes;
  try {
    cycleNotes = JSON.parse(localStorage.getItem('cycleNotes')) || [];
  } catch (_) {
    cycleNotes = [];
  }
  const saveCycleNotes = () => localStorage.setItem('cycleNotes', JSON.stringify(cycleNotes));

  const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

  if (boot.calendar && boot.calendar.length) {
    calendarCache[monthKey(currentYear, currentMonth)] = boot.calendar;
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
    viewCalendar: $('viewCalendar'),
    viewAidePlanif: $('viewAidePlanif'),
    prevMonth: $('prevMonth'),
    nextMonth: $('nextMonth'),
    todayBtn: $('todayBtn'),
    monthLabel: $('monthLabel'),
    monthGrid: $('monthGrid'),
    nWeeks: $('nWeeks'),
    generateBtn: $('generateBtn'),
    cycleSummary: $('cycleSummary'),
    cycleRangeLabel: $('cycleRangeLabel'),
    cycleNoteInput: $('cycleNoteInput'),
    cycleNoteDisplay: $('cycleNoteDisplay'),
    saveCycleNoteBtn: $('saveCycleNoteBtn'),
    cycleWeeksContainer: $('cycleWeeksContainer'),
    weekTemplatesContainer: $('weekTemplatesContainer'),
    sendResult: $('sendResult'),
    editModal: $('editModal'),
    editName: $('editName'),
    editDate: $('editDate'),
    editType: $('editType'),
    editQualityKind: $('editQualityKind'),
    editIntervalsFields: $('editIntervalsFields'),
    editReps: $('editReps'),
    editWorkDuration: $('editWorkDuration'),
    editWorkLow: $('editWorkLow'),
    editWorkHigh: $('editWorkHigh'),
    editRecDuration: $('editRecDuration'),
    editDuration: $('editDuration'),
    editRpe: $('editRpe'),
    editDescription: $('editDescription'),
    editSave: $('editSave'),
    editCancel: $('editCancel'),
    aiPlanModal: $('aiPlanModal'),
    aiPlanType: $('aiPlanType'),
    aiPlanAcwr: $('aiPlanAcwr'),
    aiPlanComment: $('aiPlanComment'),
    aiPlanCancel: $('aiPlanCancel'),
    aiPlanGenerate: $('aiPlanGenerate'),
  };

  function aideVisible() {
    return el.viewAidePlanif && el.viewAidePlanif.style.display !== 'none';
  }

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
    return `<div class="workout-card${isSel ? ' selected' : ''}" data-id="${escHtml(s.id)}">
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
    if (el.viewAidePlanif && el.viewAidePlanif.style.display !== 'none') renderAidePlanif();
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
    renderMonthCalendar();
  }

  function renderMonthCalendar() {
    const mk = monthKey(currentYear, currentMonth);
    const sessions = calendarCache[mk]; // null = loading
    const todayStr = todayIso();
    const monthStr = String(currentMonth).padStart(2, '0');
    const canAdd = !!selectedSession;

    el.monthLabel.textContent = fmtMonthFR(currentYear, currentMonth);

    const weeks = getMonthWeeks(currentYear, currentMonth);
    let html = `<div class="mcal-header">${DAYS_FR.map((d) => `<div class="mcal-dayname">${d}</div>`).join('')}</div>`;

    for (const monIso of weeks) {
      html += '<div class="mcal-week">';
      for (let i = 0; i < 7; i++) {
        const date = addDaysIso(monIso, i);
        const inMonth = date.slice(5, 7) === monthStr;
        const isToday = date === todayStr;
        const isPast = date < todayStr;
        const daySessions = sessions ? sessions.filter((s) => s.date === date) : [];
        const dayPending = pendingSessions.filter((p) => p.date === date);

        html += `<div class="mcal-day${inMonth ? '' : ' outside'}${isToday ? ' today' : ''}${isPast ? ' past' : ''}${canAdd && inMonth ? ' droppable' : ''}" data-date="${date}">
          <div class="mcal-day-num${isToday ? ' today-badge' : ''}">${parseInt(date.slice(8), 10)}</div>
          <div class="mcal-sessions">
            ${sessions === null && inMonth ? '<div class="chip-loading">…</div>' : ''}
            ${daySessions.map((s) => sessionChipHtml(s, false)).join('')}
            ${dayPending.map((s) => sessionChipHtml(s, true)).join('')}
          </div>
        </div>`;
      }
      html += '</div>';
    }

    el.monthGrid.innerHTML = html;
  }

  function sessionChipHtml(s, isPending) {
    const icon = sportIcon(s.type || s.sport || '');
    const name = escHtml(s.name || s.seance || '');
    const dur = s.moving_time ? fmtMinutes(Math.round(s.moving_time / 60)) : s.temps || '';
    if (isPending) {
      return `<div class="session-chip pending" draggable="true" data-pending-id="${escHtml(s.id)}" title="Glisser pour déplacer · cliquer pour modifier">
        <span>${icon} ${name}</span>
        ${s.qualityKind ? `<span class="chip-quality">${escHtml(s.qualityKind)}</span>` : ''}
        ${dur ? `<span class="chip-dur">${dur}</span>` : ''}
        <button class="chip-remove" title="Supprimer">✕</button>
      </div>`;
    }
    return `<div class="session-chip">
      <span>${icon} ${name}</span>
      ${dur ? `<span class="chip-dur">${dur}</span>` : ''}
      ${s.trainingLoad ? `<span class="chip-load">${s.trainingLoad}</span>` : ''}
    </div>`;
  }

  function movePendingSession(id, date) {
    const p = pendingSessions.find((s) => s.id === id);
    if (!p || !date || p.date === date) return;
    p.date = date;
    updatePendingBanner();
    renderMonthCalendar();
    if (aideVisible()) renderAidePlanif();
  }

  /** Câble le glisser-déposer des séances en attente vers les cellules de jour d'un conteneur. */
  function wireDragAndDrop(container, daySelector) {
    if (!container) return;
    container.addEventListener('dragstart', (e) => {
      const chip = e.target.closest('.session-chip.pending');
      if (!chip) return;
      e.dataTransfer.setData('text/plain', chip.dataset.pendingId);
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    container.addEventListener('dragend', (e) => {
      const chip = e.target.closest('.session-chip.pending');
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
      if (!cell) return;
      e.preventDefault();
      cell.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id && cell.dataset.date) movePendingSession(id, cell.dataset.date);
    });
  }

  function addPendingSession(date) {
    if (!selectedSession) return;
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSessions.push({
      id,
      date,
      name: selectedSession.name,
      type: selectedSession.type,
      description: selectedSession.description || '',
      moving_time: selectedSession.moving_time || 0,
      rpe: selectedSession.rpe || 3,
    });
    updatePendingBanner();
    renderMonthCalendar();
    if (el.viewAidePlanif && el.viewAidePlanif.style.display !== 'none') renderAidePlanif();
  }

  function addManualPlanSession(date) {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSessions.push({ id, date, name: 'Séance libre', type: 'Run', description: '', moving_time: 45 * 60, rpe: 3 });
    updatePendingBanner();
    renderMonthCalendar();
    renderAidePlanif();
    openEditModal(id);
  }

  function updatePendingBanner() {
    if (pendingSessions.length === 0) {
      el.pendingBanner.style.display = 'none';
    } else {
      el.pendingBanner.style.display = 'flex';
      el.pendingCount.textContent = `${pendingSessions.length} séance${pendingSessions.length > 1 ? 's' : ''} en attente d'envoi`;
    }
  }

  // ── Séances qualité (intervalles paramétrables) ────────────────
  function qualityOptionsForType(type) {
    const lib = SESSION_LIBRARY[type] || {};
    return Object.entries(lib).filter(([, t]) => t.structure === 'warmup_reps_cooldown').map(([name]) => name);
  }

  /** Applique un template d'intervalles (bibliothèque) à une séance : régénère description/durée/RPE. */
  function applyQualityTemplate(p, type, kind) {
    const template = SESSION_LIBRARY[type] && SESSION_LIBRARY[type][kind];
    if (!template) return false;
    const { description, durationMin } = buildSessionDescription(template);
    p.type = type;
    p.qualityKind = kind;
    p.qualityParams = {
      reps: template.reps, work_duration: template.work_duration, work_low: template.work_low, work_high: template.work_high,
      rec_duration: template.rec_duration, rec_low: template.rec_low, rec_high: template.rec_high,
      warmup_duration: template.warmup_duration, warmup_low: template.warmup_low, warmup_high: template.warmup_high,
      cooldown_duration: template.cooldown_duration, cooldown_low: template.cooldown_low, cooldown_high: template.cooldown_high,
      zone_unit: template.zone_unit,
    };
    p.description = description;
    p.moving_time = Math.round(durationMin * 60);
    p.rpe = template.rpe || p.rpe || 5;
    p.name = `${type === 'Ride' ? 'Vélo' : 'CAP'} — ${kind}`;
    return true;
  }

  function populateQualityKindOptions(type, selected) {
    const opts = qualityOptionsForType(type);
    el.editQualityKind.innerHTML = '<option value="">— Aucune (séance simple/manuelle) —</option>' +
      opts.map((name) => `<option value="${escHtml(name)}"${name === selected ? ' selected' : ''}>${escHtml(name)}</option>`).join('');
  }

  function fillIntervalFieldsFromParams(params) {
    const p = params || {};
    el.editReps.value = p.reps ?? 3;
    el.editWorkDuration.value = p.work_duration ?? 8;
    el.editWorkLow.value = p.work_low ?? 90;
    el.editWorkHigh.value = p.work_high ?? 100;
    el.editRecDuration.value = p.rec_duration ?? 2;
  }

  function currentIntervalOverrides() {
    return {
      reps: Math.max(1, parseInt(el.editReps.value) || 1),
      work_duration: Math.max(0.25, parseFloat(el.editWorkDuration.value) || 0.25),
      work_low: parseFloat(el.editWorkLow.value) || 0,
      work_high: parseFloat(el.editWorkHigh.value) || 0,
      rec_duration: Math.max(0, parseFloat(el.editRecDuration.value) || 0),
    };
  }

  /** Recalcule description/durée/RPE à partir du template + des champs d'intervalles édités. */
  function refreshQualityPreview() {
    const kind = el.editQualityKind.value;
    el.editIntervalsFields.style.display = kind ? 'grid' : 'none';
    if (!kind) return;
    const template = SESSION_LIBRARY[el.editType.value] && SESSION_LIBRARY[el.editType.value][kind];
    if (!template) return;
    const merged = { ...template, ...currentIntervalOverrides() };
    const { description, durationMin } = buildSessionDescription(merged);
    el.editDescription.value = description;
    el.editDuration.value = Math.round(durationMin);
    el.editRpe.value = template.rpe || el.editRpe.value;
  }

  // ── Edit modal (pending session) ──────────────────────────────
  function openEditModal(pendingId) {
    const p = pendingSessions.find((s) => s.id === pendingId);
    if (!p) return;
    editingPendingId = pendingId;
    el.editName.value = p.name;
    el.editDate.value = p.date;
    el.editType.value = p.type;
    populateQualityKindOptions(p.type, p.qualityKind);
    fillIntervalFieldsFromParams(p.qualityParams);
    el.editIntervalsFields.style.display = p.qualityKind ? 'grid' : 'none';
    el.editDuration.value = Math.round((p.moving_time || 0) / 60);
    el.editRpe.value = p.rpe || 3;
    el.editDescription.value = p.description || '';
    el.editModal.style.display = 'flex';
  }

  function closeEditModal() {
    editingPendingId = null;
    el.editModal.style.display = 'none';
  }

  function saveEditModal() {
    const p = pendingSessions.find((s) => s.id === editingPendingId);
    if (!p) return closeEditModal();
    const kind = el.editQualityKind.value;
    p.name = el.editName.value.trim() || p.name;
    p.date = el.editDate.value || p.date;
    p.type = el.editType.value;
    p.moving_time = Math.round((parseFloat(el.editDuration.value) || 0) * 60);
    p.rpe = Math.min(10, Math.max(1, parseInt(el.editRpe.value) || 3));
    p.description = el.editDescription.value;
    if (kind) {
      p.qualityKind = kind;
      p.qualityParams = { ...currentIntervalOverrides() };
    } else {
      p.qualityKind = null;
      p.qualityParams = null;
    }
    closeEditModal();
    renderMonthCalendar();
    if (aideVisible()) renderAidePlanif();
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

  // ── Send pending sessions ──────────────────────────────────────
  async function sendPendingSessions() {
    if (!pendingSessions.length) return;
    el.sendPendingBtn.disabled = true;
    el.sendResult.innerHTML = '<div class="alert alert-info">Envoi en cours…</div>';

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
        body: JSON.stringify({ athleteId, events }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Échec');
      el.sendResult.innerHTML = `<div class="alert alert-success">✅ ${pendingSessions.length} séance(s) envoyée(s) avec succès dans Intervals.icu.</div>`;
      const affectedMonths = [...new Set(pendingSessions.map((p) => p.date.slice(0, 7)))];
      affectedMonths.forEach((mk) => { delete calendarCache[mk]; });
      pendingSessions = [];
      updatePendingBanner();
      renderMonthCalendar();
      fetchCalendarMonth(currentYear, currentMonth);
    } catch (e) {
      el.sendResult.innerHTML = `<div class="alert alert-error">Erreur : ${escHtml(e.message)}</div>`;
    } finally {
      el.sendPendingBtn.disabled = false;
    }
  }

  // ── Aide planif ────────────────────────────────────────────────
  function pendingLoad(p) {
    return (p.rpe || 3) * Math.round((p.moving_time || 0) / 60);
  }

  function currentWeekIso() {
    return getMondayIso(todayIso());
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

  /**
   * Charge totale d'une semaine pour l'ACWR prévisionnel : pour la semaine en cours, projection
   * "pure plan" (charge déjà planifiée sur Intervals.icu pour toute la semaine + séances en attente
   * non envoyées), sans mélanger le réel déjà fait — même logique que le dashboard, pour que les deux
   * s'accordent. Pour les semaines futures, il n'existe de toute façon aucun réel : uniquement le plan.
   */
  function weekTotalLoad(week) {
    if (week === currentWeekIso()) {
      const plannedTotal = (chronicData && chronicData.currentWeekPlannedTotal) || 0;
      return plannedTotal + weekPendingLoad(week);
    }
    return weekPendingLoad(week);
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
    for (const week of getPlanWeeks(16)) {
      if (week >= weekStart) break;
      loads.push(weekTotalLoad(week));
    }
    const windowVals = loads.slice(-4);
    if (windowVals.length >= 3) return windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
    return chronicData ? chronicData.chronic : 0;
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

    updatePendingBanner();
    renderMonthCalendar();
    renderAidePlanif();
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
    const btn = el.cycleWeeksContainer && el.cycleWeeksContainer.querySelector(`.cw-ai-prefill[data-week="${week}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ IA…'; }

    try {
      const nWeeksInput = parseInt(el.nWeeks.value) || 8;
      const cycleStart = getPlanWeeks(nWeeksInput)[0];
      const note = findCycleNote(cycleStart, nWeeksInput);

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
          constraints: note ? note.note : '',
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

      updatePendingBanner();
      renderMonthCalendar();
      renderAidePlanif();
      if (body.plan.rationale && el.sendResult) {
        el.sendResult.innerHTML = `<div class="alert alert-info">🤖 ${escHtml(body.plan.rationale)}</div>`;
      }
    } catch (e) {
      if (el.sendResult) el.sendResult.innerHTML = `<div class="alert alert-error">Erreur IA : ${escHtml(e.message)}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = '✨ IA'; }
    }
  }

  // ── Note de cycle ───────────────────────────────────────────────
  function findCycleNote(startWeek, nWeeks) {
    return cycleNotes.find((c) => c.startWeek === startWeek && c.nWeeks === nWeeks);
  }

  function renderCycleNote(planWeeks, nWeeks) {
    if (!el.cycleRangeLabel) return;
    const startWeek = planWeeks[0];
    const endWeek = addDaysIso(planWeeks[planWeeks.length - 1], 6);
    el.cycleRangeLabel.textContent = `${fmtDateFR(startWeek)} → ${fmtDateFR(endWeek)}`;
    const existing = findCycleNote(startWeek, nWeeks);
    if (el.cycleNoteInput) el.cycleNoteInput.value = existing ? existing.note : '';
    if (el.cycleNoteDisplay) el.cycleNoteDisplay.textContent = existing && existing.note ? `📝 ${existing.note}` : '';
  }

  async function saveCycleNote() {
    const nWeeks = parseInt(el.nWeeks.value) || 8;
    const planWeeks = getPlanWeeks(nWeeks);
    const startWeek = planWeeks[0];
    const note = el.cycleNoteInput.value.trim();
    const existing = findCycleNote(startWeek, nWeeks);
    if (existing) existing.note = note;
    else cycleNotes.push({ id: `cycle-${Date.now()}`, startWeek, nWeeks, note });
    saveCycleNotes();

    if (!note) {
      if (el.cycleNoteDisplay) el.cycleNoteDisplay.textContent = '';
      return;
    }
    if (el.cycleNoteDisplay) el.cycleNoteDisplay.textContent = `📝 ${note} · envoi à Intervals.icu…`;
    if (el.saveCycleNoteBtn) el.saveCycleNoteBtn.disabled = true;
    try {
      const events = [{
        start_date_local: eventStartDateTime(startWeek),
        category: 'NOTE',
        name: note,
        external_id: `dashboard-cycle-${startWeek}-${nWeeks}`,
      }];
      const res = await fetch('/api/planning/send-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteId, events }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Échec');
      if (el.cycleNoteDisplay) el.cycleNoteDisplay.textContent = `📝 ${note} · envoyée à Intervals.icu`;
    } catch (e) {
      if (el.cycleNoteDisplay) el.cycleNoteDisplay.textContent = `📝 ${note} · ⚠️ non envoyée (${e.message})`;
    } finally {
      if (el.saveCycleNoteBtn) el.saveCycleNoteBtn.disabled = false;
    }
  }

  async function renderAidePlanif() {
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
    // Semaines réalisées (4 dernières max) : point de départ "comme si rien n'était encore planifié".
    const realized = historicalWeeklyLoads();
    const nRealized = realized.length;
    const projection = projectWeeklyAcwr(planWeeks);

    renderCycleNote(planWeeks, nWeeks);

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
    const plannedBars = timelineWeeks.map((week, i) => (i < nRealized ? 0 : Math.round(weekPendingLoad(week))));

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
          const week = planWeeks[idx - nRealized];
          const card = document.getElementById(`plan-week-${week}`);
          if (!card) return;
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          card.classList.add('flash');
          setTimeout(() => card.classList.remove('flash'), 1400);
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

    renderCycleWeeks(planWeeks, projection);
    renderWeekTemplates();
  }

  function planDayCellHtml(date, dayIndex) {
    const dayPending = pendingSessions.filter((p) => p.date === date);
    const isPast = date < todayIso();
    return `<div class="plan-day${isPast ? ' past' : ''}" data-date="${date}">
      <div class="plan-day-head"><span>${DAYS_FR[dayIndex]}</span><strong>${fmtDateFR(date)}</strong></div>
      <div class="plan-day-sessions">
        ${dayPending.map((s) => sessionChipHtml(s, true)).join('') || '<span class="plan-empty">Libre</span>'}
      </div>
      <button class="plan-add-session" data-date="${date}">+ Séance</button>
    </div>`;
  }

  function renderCycleWeeks(planWeeks, projection) {
    if (!el.cycleWeeksContainer) return;

    el.cycleWeeksContainer.innerHTML = planWeeks.map((week, idx) => {
      const state = getWeekState(week);
      const metrics = projection[idx];
      const acwrText = metrics.acwr == null ? 'n/a' : metrics.acwr.toFixed(2);
      const days = Array.from({ length: 7 }, (_, i) => planDayCellHtml(addDaysIso(week, i), i)).join('');

      return `<div class="cycle-week-card${metrics.isCurrentWeek ? ' is-current' : ''}" id="plan-week-${week}" data-week="${week}">
        <div class="cycle-week-header">
          <div>
            <strong>Semaine du ${fmtDateFR(week)}${metrics.isCurrentWeek ? ' (en cours)' : ''}</strong>
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
            <button class="cw-ai-prefill btn-sm" data-week="${week}" title="Proposer une semaine via IA (Claude), en tenant compte de la note de cycle comme contraintes">✨ IA</button>
          </div>
        </div>
        <div class="plan-week-calendar">${days}</div>
      </div>`;
    }).join('');
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
    updatePendingBanner();
    renderMonthCalendar();
    // Navigate to the calendar month containing the applied week
    const weekDate = new Date(weekStart + 'T00:00:00Z');
    currentYear = weekDate.getUTCFullYear();
    currentMonth = weekDate.getUTCMonth() + 1;
    document.querySelectorAll('.plan-tab').forEach((t) => t.classList.remove('active'));
    document.querySelector('.plan-tab[data-view="calendar"]').classList.add('active');
    el.viewCalendar.style.display = 'block';
    el.viewAidePlanif.style.display = 'none';
    fetchCalendarMonth(currentYear, currentMonth);
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
      loadIntervalsWorkouts();
      loadChronicData();
      fetchCalendarMonth(currentYear, currentMonth);
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
    updatePendingBanner();
    renderMonthCalendar();
    if (el.viewAidePlanif && el.viewAidePlanif.style.display !== 'none') renderAidePlanif();
  });
  el.sendPendingBtn.addEventListener('click', sendPendingSessions);

  document.querySelectorAll('.plan-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.plan-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      el.viewCalendar.style.display = view === 'calendar' ? 'block' : 'none';
      el.viewAidePlanif.style.display = view === 'aide' ? 'block' : 'none';
      if (view === 'aide') renderAidePlanif();
    });
  });

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

  // Calendar delegation: add / edit / remove
  el.monthGrid.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.chip-remove');
    if (removeBtn) {
      const chip = removeBtn.closest('.session-chip');
      if (chip && chip.dataset.pendingId) {
        pendingSessions = pendingSessions.filter((p) => p.id !== chip.dataset.pendingId);
        updatePendingBanner(); renderMonthCalendar();
        if (el.viewAidePlanif && el.viewAidePlanif.style.display !== 'none') renderAidePlanif();
      }
      return;
    }
    const chip = e.target.closest('.session-chip.pending');
    if (chip && chip.dataset.pendingId) { openEditModal(chip.dataset.pendingId); return; }
    const dayCell = e.target.closest('.mcal-day:not(.outside)');
    if (dayCell && selectedSession) addPendingSession(dayCell.dataset.date);
  });

  el.editSave.addEventListener('click', saveEditModal);
  el.editCancel.addEventListener('click', closeEditModal);
  el.editModal.addEventListener('click', (e) => { if (e.target === el.editModal) closeEditModal(); });
  el.editType.addEventListener('change', () => {
    populateQualityKindOptions(el.editType.value, '');
    el.editQualityKind.value = '';
    el.editIntervalsFields.style.display = 'none';
  });
  el.editQualityKind.addEventListener('change', () => {
    const template = SESSION_LIBRARY[el.editType.value] && SESSION_LIBRARY[el.editType.value][el.editQualityKind.value];
    if (template) fillIntervalFieldsFromParams(template);
    refreshQualityPreview();
  });
  [el.editReps, el.editWorkDuration, el.editWorkLow, el.editWorkHigh, el.editRecDuration].forEach((input) => {
    input.addEventListener('input', refreshQualityPreview);
  });

  el.generateBtn.addEventListener('click', renderAidePlanif);
  if (el.nWeeks) el.nWeeks.addEventListener('change', renderAidePlanif);
  if (el.saveCycleNoteBtn) el.saveCycleNoteBtn.addEventListener('click', saveCycleNote);

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

  if (el.cycleWeeksContainer) {
    el.cycleWeeksContainer.addEventListener('change', (e) => {
      const week = e.target.dataset.week;
      if (!week) return;
      const state = getWeekState(week);
      if (e.target.classList.contains('cw-plan-type')) state.planningType = e.target.value;
      else if (e.target.classList.contains('cw-run')) state.nRun = Math.max(0, parseInt(e.target.value) || 0);
      else if (e.target.classList.contains('cw-bike')) state.nBike = Math.max(0, parseInt(e.target.value) || 0);
      else if (e.target.classList.contains('cw-strength')) state.nStrength = Math.max(0, parseInt(e.target.value) || 0);
    });

    el.cycleWeeksContainer.addEventListener('click', (e) => {
      const prefillBtn = e.target.closest('.cw-prefill');
      if (prefillBtn) { applyGeneratedPlanWeek(prefillBtn.dataset.week); return; }

      const aiBtn = e.target.closest('.cw-ai-prefill');
      if (aiBtn) { openAiPlanModal(aiBtn.dataset.week); return; }

      const removeBtn = e.target.closest('.chip-remove');
      if (removeBtn) {
        const chip = removeBtn.closest('.session-chip');
        if (chip && chip.dataset.pendingId) {
          pendingSessions = pendingSessions.filter((p) => p.id !== chip.dataset.pendingId);
          updatePendingBanner();
          renderMonthCalendar();
          renderAidePlanif();
        }
        return;
      }
      const chip = e.target.closest('.session-chip.pending');
      if (chip && chip.dataset.pendingId) { openEditModal(chip.dataset.pendingId); return; }
      const addBtn = e.target.closest('.plan-add-session');
      if (addBtn) addManualPlanSession(addBtn.dataset.date);
    });

    wireDragAndDrop(el.cycleWeeksContainer, '.plan-day');
  }

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

})();
