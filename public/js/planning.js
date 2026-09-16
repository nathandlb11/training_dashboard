/* global Chart, Format */
(function () {
  'use strict';

  const boot = window.__PLANNING_BOOTSTRAP__ || {};
  if (!document.getElementById('planningLayout')) return;

  window.addEventListener('error', (e) => {
    const el = document.getElementById('intervalsLibrary');
    if (el) el.innerHTML = `<div class="alert alert-error" style="margin:10px;font-size:0.8rem;">JS Error: ${e.message}<br>${e.filename}:${e.lineno}</div>`;
  });

  const { fmtMinutes, fmtTime, parseDescriptionDurationMinutes, parseDescriptionSteps } = Format;

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
  const SPORT_TYPE_MAP = { WeightTraining: 'Strength', TrailRun: 'Run', VirtualRide: 'Ride', GravelRide: 'Ride', MountainBikeRide: 'Ride', OpenWaterSwim: 'Swim' };
  const SPORT_ICONS = { Run: '🏃', Ride: '🚴', Swim: '🏊', Strength: '💪', Hike: '🥾', Walk: '🚶' };
  const sportIcon = (t) => SPORT_ICONS[SPORT_TYPE_MAP[t] || t] || '🎽';
  const CHART_HORIZON_WEEKS = 8; // horizon fixe du graphique charge/ACWR (plus de réglage utilisateur)

  /** Code couleur du % de complétion de charge (prévue vs réelle) : <80% sous-réalisée, 80-120% dans la cible, >120% sur-réalisée. */
  const completionColorClass = (pct) => {
    if (pct == null || !Number.isFinite(pct)) return '';
    if (pct < 80) return 'pct-low';
    if (pct <= 120) return 'pct-ok';
    return 'pct-high';
  };

  /** Vitesse en m/s (champ Intervals.icu `average_speed`) -> allure "min:ss/km". */
  const fmtPaceFromSpeed = (speedMs) => {
    if (!speedMs || !Number.isFinite(speedMs) || speedMs <= 0) return null;
    const secPerKm = 1000 / speedMs;
    const min = Math.floor(secPerKm / 60);
    const sec = Math.round(secPerKm % 60);
    return `${min}:${String(sec).padStart(2, '0')}/km`;
  };

  // ── State ──────────────────────────────────────────────────────
  let athleteId = boot.athleteId || '0';
  let chronicData = boot.chronicData;
  let calendarCache = {}; // "YYYY-MM" -> [sessions] | null (loading)
  let pendingSessions = [];
  let libraryTargetDate = null; // date en attente de sélection dans la modale bibliothèque
  let chartHidden = localStorage.getItem('planningChartHidden') === '1';
  const _today = new Date();
  let currentYear = _today.getFullYear();
  let currentMonth = _today.getMonth() + 1;
  let intervalsWorkouts = [];
  let workoutFolders = [];
  let folderFilter = '';
  let searchQuery = '';
  let pmcChart = null;
  let editingPendingId = null;
  let editingRealId = null;
  let pendingEdits = {}; // eventId (string) -> { date, name, type, description, moving_time, rpe, qualityKind, qualityParams }
  let pendingDeletes = new Set(); // Set<eventId (string)>
  let weekPlanState = {}; // weekIso -> { planningType, nRun, nBike, nStrength }
  let recapActivityId = null; // id de l'activité réelle affichée dans le récap ouvert (pour "Analyse avancée")
  let recapSportKey = null; // 'Run' | 'Ride' | null (sport supporté par l'analyse avancée)

  const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

  // Le boot ne couvre que today..+28 (fenêtre glissante côté serveur) : la partie AVANT aujourd'hui du
  // mois courant (séances passées) y manque. `bootSeededMonthKey` force fetchCalendarMonth à quand même
  // refaire un fetch complet une première fois pour ce mois, malgré le cache déjà "défini" par le boot.
  let bootSeededMonthKey = null;

  if (boot.calendar && boot.calendar.length) {
    // boot.calendar vient d'une fenêtre glissante de 28 jours côté serveur (pas alignée sur le mois) :
    // ne garder que les dates du mois courant, sinon un mois voisin ensuite chargé séparément
    // (ex. pour l'horizon du graphique) ferait apparaitre ses séances en double dans allRealSessionsInCache.
    const monthStr = String(currentMonth).padStart(2, '0');
    const mk = monthKey(currentYear, currentMonth);
    calendarCache[mk] = boot.calendar.filter((s) => s.date && s.date.slice(5, 7) === monthStr && s.date.slice(0, 4) === String(currentYear));
    bootSeededMonthKey = mk;
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
    folderFilter: $('folderFilter'),
    libraryModal: $('libraryModal'),
    libraryCancel: $('libraryCancel'),
    librarySessionLibre: $('librarySessionLibre'),
    pendingBanner: $('pendingBanner'),
    pendingCount: $('pendingCount'),
    clearPendingBtn: $('clearPendingBtn'),
    sendPendingBtn: $('sendPendingBtn'),
    prevMonth: $('prevMonth'),
    nextMonth: $('nextMonth'),
    todayBtn: $('todayBtn'),
    exportCsvBtn: $('exportCsvBtn'),
    monthLabel: $('monthLabel'),
    monthGrid: $('monthGrid'),
    cycleSummary: $('cycleSummary'),
    sendResult: $('sendResult'),
    editModal: $('editModal'),
    editName: $('editName'),
    editRpe: $('editRpe'),
    editDescription: $('editDescription'),
    editStepChart: $('editStepChart'),
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
    chartCard: $('chartCard'),
    chartBody: $('chartBody'),
    toggleChartBtn: $('toggleChartBtn'),
    recapModal: $('recapModal'),
    recapTitle: $('recapTitle'),
    recapBody: $('recapBody'),
    recapClose: $('recapClose'),
    recapAdvancedBtn: $('recapAdvancedBtn'),
    intervalsModal: $('intervalsModal'),
    intervalsTitle: $('intervalsTitle'),
    intervalsBody: $('intervalsBody'),
    intervalsClose: $('intervalsClose'),
  };

  // ── Library ────────────────────────────────────────────────────
  function renderLibrary() {
    const q = searchQuery.toLowerCase();
    const filterFn = (s) => {
      if (folderFilter && s.folderPath !== folderFilter) return false;
      if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) return false;
      return true;
    };
    const list = intervalsWorkouts.filter(filterFn);
    if (!list.length) {
      el.intervalsLibrary.innerHTML = '<p class="caption" style="padding:10px 12px;">Aucun résultat.</p>';
      return;
    }
    // Regroupe par sous-dossier Intervals.icu (rangement de la bibliothèque), triés par chemin puis nom.
    const groups = new Map();
    list.forEach((s) => {
      const key = s.folderPath || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    const sortedKeys = [...groups.keys()].sort((a, b) => (a || '\uffff').localeCompare(b || '\uffff'));
    el.intervalsLibrary.innerHTML = sortedKeys
      .map((key) => {
        const items = groups.get(key).sort((a, b) => a.name.localeCompare(b.name));
        const header = `<div class="lib-folder-header">${escHtml(key || 'Sans dossier')}</div>`;
        return header + items.map(workoutCardHtml).join('');
      })
      .join('');
    document.querySelectorAll('.workout-card').forEach((card) => {
      card.addEventListener('click', () => {
        const session = intervalsWorkouts.find((s) => s.id === card.dataset.id);
        if (session) {
          addPendingSession(libraryTargetDate, session);
          closeLibraryModal();
        }
      });
    });
  }

  function populateFolderFilter() {
    if (!el.folderFilter) return;
    const prev = folderFilter;
    el.folderFilter.innerHTML = '<option value="">Tous les dossiers</option>' +
      workoutFolders.map((f) => `<option value="${escHtml(f.path)}">${escHtml(f.path)}</option>`).join('');
    el.folderFilter.value = workoutFolders.some((f) => f.path === prev) ? prev : '';
    folderFilter = el.folderFilter.value;
  }

  function workoutCardHtml(s) {
    const dur = s.moving_time ? fmtMinutes(Math.round(s.moving_time / 60)) : '';
    return `<div class="workout-card" data-id="${escHtml(s.id)}" title="Cliquer pour ajouter cette séance au jour choisi">
      <div class="workout-card-header">
        <span class="workout-icon">${sportIcon(s.type)}</span>
        <span class="workout-name">${escHtml(s.name)}</span>
      </div>
      ${dur ? `<div class="workout-meta">${dur}${s.rpe ? ` · RPE ${s.rpe}` : ''}</div>` : ''}
    </div>`;
  }

  function openLibraryModal(date) {
    libraryTargetDate = date;
    el.libraryModal.style.display = 'flex';
  }

  function closeLibraryModal() {
    el.libraryModal.style.display = 'none';
    libraryTargetDate = null;
  }

  async function loadIntervalsWorkouts() {
    el.intervalsLibrary.innerHTML = '<div class="lib-loading"><div class="spinner"></div><span>Chargement…</span></div>';
    try {
      // La bibliothèque de séances appartient au compte principal, pas à l'athlète sélectionné
      // dans le sélecteur — pas de paramètre athleteId ici (voir getWorkoutLibrary côté serveur).
      const res = await fetch('/api/planning/workouts');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      workoutFolders = body.folders || [];
      intervalsWorkouts = (body.workouts || []).map((w) => {
        const type = SPORT_TYPE_MAP[w.type] || w.type || 'Run';
        return {
          id: `intervals::${w.id}`,
          source: 'intervals',
          name: w.name || 'Sans nom',
          type,
          description: w.description || '',
          moving_time: w.moving_time || 0,
          rpe: null,
          intervals_id: w.id,
          folderPath: w.folderPath || '',
        };
      });
      populateFolderFilter();
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
    if (calendarCache[mk] !== undefined && mk !== bootSeededMonthKey) return;
    bootSeededMonthKey = null; // ne contourne le dédoublonnage qu'une seule fois (premier fetch réel du mois du boot)
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

  function dayCellHtml(date, inMonth, todayStr) {
    const isToday = date === todayStr;
    const isPast = date < todayStr;
    const daySessions = realSessionsForDate(date);
    const dayPending = pendingSessions.filter((p) => p.date === date);
    const mk = monthKey(...date.split('-').slice(0, 2).map(Number));
    const loading = calendarCache[mk] === null;

    return `<div class="mcal-day${inMonth ? '' : ' outside'}${isToday ? ' today' : ''}${isPast ? ' past' : ''}" data-date="${date}">
      <div class="mcal-day-num${isToday ? ' today-badge' : ''}">${parseInt(date.slice(8), 10)}</div>
      <div class="mcal-sessions">
        ${loading && inMonth ? '<div class="chip-loading">…</div>' : ''}
        ${daySessions.map((s) => sessionChipHtml(s, 'real')).join('')}
        ${dayPending.map((s) => sessionChipHtml(s, 'pending')).join('')}
        ${!isPast && inMonth ? `<button class="plan-add-session" data-date="${date}">+<span class="plan-add-label"> Séance</span></button>` : ''}
      </div>
    </div>`;
  }

  /** Barre d'actions au-dessus d'une semaine du calendrier (charge/ACWR prévu), affichée pour la semaine
   * en cours et les semaines futures. Génération automatique (IA/Auto) retirée de l'UI pour l'instant
   * (tout reste manuel) — le code correspondant (getWeekState/applyAiPlanWeek/applyDeterministicPlanWeek)
   * est conservé intact pour une réactivation ultérieure. */
  function weekActionsHtml(week) {
    const metrics = weekMetrics(week);
    const acwrText = metrics.acwr == null ? 'n/a' : metrics.acwr.toFixed(2);
    const isCurrent = week === currentWeekIso();
    return `<div class="mcal-week-actions cycle-week-header" data-week="${week}">
      <div>
        <strong>Semaine du ${fmtDateFR(week)}${isCurrent ? ' (en cours)' : ''}</strong>
        <span class="caption">${Math.round(metrics.weeklyLoad)} Foster · ACWR ${acwrText}</span>
      </div>
    </div>`;
  }

  function renderMonthCalendar() {
    const mk = monthKey(currentYear, currentMonth);
    if (calendarCache[mk] === undefined) fetchCalendarMonth(currentYear, currentMonth);
    const todayStr = todayIso();
    const monthStr = String(currentMonth).padStart(2, '0');

    el.monthLabel.textContent = fmtMonthFR(currentYear, currentMonth);

    const weeks = getMonthWeeks(currentYear, currentMonth);
    let html = `<div class="mcal-header">${DAYS_FR.map((d) => `<div class="mcal-dayname">${d}</div>`).join('')}</div>`;

    for (const monIso of weeks) {
      const weekEnd = addDaysIso(monIso, 6);
      const daysHtml = Array.from({ length: 7 }, (_, i) => dayCellHtml(addDaysIso(monIso, i), addDaysIso(monIso, i).slice(5, 7) === monthStr, todayStr)).join('');
      if (weekEnd >= todayStr) {
        html += `<div class="mcal-week-block">${weekActionsHtml(monIso)}<div class="mcal-week">${daysHtml}</div></div>`;
      } else {
        html += `<div class="mcal-week">${daysHtml}</div>`;
      }
    }

    el.monthGrid.innerHTML = html;
  }

  /** Charge Foster = RPE × durée, comme pour les séances en attente. Pour les séances "hors plan"
   * (sans RPE prévu) ou en dernier recours, on retombe sur la charge réelle déjà calculée côté serveur. */
  function realSessionLoad(s, durMin) {
    if (s.rpe && durMin) return Math.round(s.rpe * durMin);
    if (Number.isFinite(s.realLoad)) return Math.round(s.realLoad);
    return Number.isFinite(s.trainingLoad) ? Math.round(s.trainingLoad) : null;
  }

  function sessionChipHtml(s, mode) {
    const icon = sportIcon(s.type || s.sport || '');
    const name = escHtml(s.name || s.seance || '');
    const durMin = s.moving_time ? Math.round(s.moving_time / 60) : (s.movingTime ? Math.round(s.movingTime / 60) : null);
    const dur = durMin ? fmtMinutes(durMin) : (s.temps || '');
    if (mode === 'pending') {
      const load = Math.round(pendingLoad(s));
      return `<div class="session-chip pending" draggable="true" data-pending-id="${escHtml(s.id)}" title="${name} · Glisser pour déplacer · cliquer pour modifier">
        <span class="chip-icon">${icon}</span><span class="chip-name">${name}</span>
        ${s.qualityKind ? `<span class="chip-quality">${escHtml(s.qualityKind)}</span>` : ''}
        ${dur ? `<span class="chip-dur">${dur}</span>` : ''}
        <span class="chip-load">${load}</span>
        <button class="chip-remove" title="Supprimer">✕</button>
      </div>`;
    }
    const load = realSessionLoad(s, durMin);
    const isExtra = s.status === 'extra';
    const isPastRealized = s.status === 'done' || s.status === 'missed';
    // Fond du chip : réalisée (vert) / non réalisée (rouge) / hors plan (bleu) — reste constant,
    // seul le score de complétion (chip-pct) change de couleur selon le seuil (jaune <80%, vert
    // 80-120%, rouge >120%).
    const statusCls = isExtra ? ' status-extra' : (isPastRealized ? ` status-${s.status}` : '');
    const pct = isPastRealized && Number.isFinite(s.completionPct) ? s.completionPct : null;
    const pctCls = pct != null ? completionColorClass(pct) : '';
    const statusLabel = isExtra
      ? ' · Hors plan (réalisée)'
      : s.status === 'done' ? ` · Réalisée (${pct}% de la charge prévue)`
      : s.status === 'missed' ? ' · Non réalisée'
      : '';
    const cls = `session-chip real${statusCls}${s.edited ? ' edited' : ''}${s.toDelete ? ' to-delete' : ''}`;
    const draggable = !isExtra && !s.toDelete;
    // Cliquer sur une séance passée (réalisée, manquée ou hors plan) ouvre le récap détaillé plutôt
    // que l'éditeur (qui n'a de sens que pour une séance à venir/du jour, ou une activité réelle éditable).
    const clickHint = isExtra || isPastRealized ? 'cliquer pour voir le détail' : 'cliquer pour modifier';
    const dragHint = draggable ? 'Glisser pour déplacer · ' : '';
    const removeHint = isExtra ? '' : ` · ✕ pour ${s.toDelete ? 'annuler la suppression' : 'supprimer'} (confirmation demandée avant envoi)`;
    const removeBtn = isExtra ? '' : `<button class="chip-remove" title="${s.toDelete ? 'Annuler la suppression' : 'Supprimer'}">${s.toDelete ? '↺' : '✕'}</button>`;
    return `<div class="${cls}" draggable="${draggable}" data-event-id="${escHtml(s.id)}" data-status="${s.status || ''}" title="${name}${statusLabel} · ${dragHint}${clickHint}${removeHint}">
      <span class="chip-icon">${icon}</span><span class="chip-name">${name}</span>
      ${dur ? `<span class="chip-dur">${dur}</span>` : ''}
      ${load != null ? `<span class="chip-load">${load}</span>` : ''}
      ${pct != null ? `<span class="chip-pct ${pctCls}">${pct}%</span>` : ''}
      ${removeBtn}
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
    if (!date || !session) return;
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSessions.push({
      id,
      date,
      name: session.name,
      type: session.type,
      description: session.description || '',
      moving_time: session.moving_time || 0,
      rpe: session.rpe || 3,
    });
    refreshAll();
  }

  function addManualPlanSession(date) {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingSessions.push({ id, date, name: 'Séance libre', type: 'Run', description: '- Séance libre 45m', moving_time: 45 * 60, rpe: 3 });
    refreshAll();
    openEditModal(id);
  }

  // ── Édition d'une séance : titre / RPE / description uniquement — la durée (et donc la charge
  // Foster) est toujours dérivée automatiquement de la description, seule source de vérité. ──
  /** Couleur d'une étape selon son intensité moyenne (% LTHR/FTP/Pace...), même échelle que les zones classiques. */
  function stepBarColor(avgPct) {
    if (avgPct == null) return '#cbd5e1';
    if (avgPct < 65) return '#38bdf8';
    if (avgPct < 85) return '#22c55e';
    if (avgPct < 95) return '#eab308';
    if (avgPct < 101) return '#f97316';
    return '#ef4444';
  }

  /** Petit schéma en barres de la séance (largeur = durée, hauteur/couleur = % d'intensité prévu), déplié à partir de la description. Injecté dans #editStepChart, qui porte déjà la classe .step-chart (conteneur flex) — ne PAS re-envelopper dans un second .step-chart, sinon les barres deviennent flex-items d'un div sans largeur propre et leurs % s'effondrent. */
  function stepChartHtml(steps) {
    if (!steps.length) return '<p class="step-chart-empty">Aucune étape reconnue dans la description.</p>';
    const totalMin = steps.reduce((sum, st) => sum + st.durationMin, 0) || 1;
    const maxPct = steps.reduce((m, st) => Math.max(m, st.highPct ?? st.lowPct ?? 0), 100);
    const chartMax = Math.max(120, Math.ceil((maxPct + 10) / 10) * 10);
    return steps
      .map((st) => {
        const widthPct = (st.durationMin / totalMin) * 100;
        const avgPct = st.lowPct != null ? (st.lowPct + st.highPct) / 2 : null;
        const heightPct = avgPct != null ? Math.max(8, Math.min(100, (avgPct / chartMax) * 100)) : 18;
        const pctLabel = st.lowPct != null ? `${st.lowPct}-${st.highPct}%${st.zone ? ' ' + st.zone : ''}` : (st.zone || 'Repos');
        const title = `${st.label ? st.label + ' · ' : ''}${fmtMinutes(st.durationMin)} · ${pctLabel}`;
        return `<div class="step-bar" style="width:${widthPct}%;height:${heightPct}%;background:${stepBarColor(avgPct)};" title="${escHtml(title)}"></div>`;
      })
      .join('');
  }

  /** Affiche en direct la durée/charge estimées + le schéma d'intensité, à partir de la description + RPE saisis. */
  function updateEditComputedInfo() {
    const minutes = parseDescriptionDurationMinutes(el.editDescription.value);
    const rpe = Math.min(10, Math.max(1, parseInt(el.editRpe.value) || 3));
    el.editComputedInfo.textContent = minutes > 0
      ? `Durée : ${fmtMinutes(minutes)} · Charge Foster : ${Math.round(minutes * rpe)}`
      : '⚠ Aucune durée reconnue dans la description — la durée précédente sera conservée.';
    if (el.editStepChart) el.editStepChart.innerHTML = stepChartHtml(parseDescriptionSteps(el.editDescription.value));
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

  // ── Récap d'une séance passée (réalisée, manquée ou hors plan) ──
  function recapRow(label, value) {
    if (value == null || value === '') return '';
    return `<div class="recap-row"><span class="recap-label">${label}</span><span class="recap-value">${value}</span></div>`;
  }

  function openRecapModal(id) {
    const s = findRealSessionById(id);
    if (!s || !el.recapModal) return;
    const isExtra = s.status === 'extra';
    const isMissed = s.status === 'missed';
    const sportKey = SPORT_TYPE_MAP[s.type] || s.type;
    const isBike = sportKey === 'Ride';

    el.recapTitle.textContent = `${sportIcon(s.type)} ${s.name || 'Séance'} — ${fmtDateFR(s.date)}`;

    let html = '';
    if (isExtra) {
      html += `<p class="pill pill-orange">Hors plan</p>`;
    } else if (isMissed) {
      html += `<p class="pill pill-red">Non réalisée</p>`;
    } else {
      // Le pill reste vert (réalisée) ; seul le % lui-même est coloré selon le seuil de complétion.
      const pctCls = completionColorClass(s.completionPct);
      const pctSpan = s.completionPct != null ? ` · <span class="chip-pct ${pctCls}">${s.completionPct}%</span>` : '';
      html += `<p class="pill pill-green">Réalisée${pctSpan}</p>`;
    }

    if (isExtra) {
      html += `<div class="recap-section"><h4>Charge réelle</h4>
        ${recapRow('Charge Foster', s.realLoad)}
        ${recapRow('RPE réel', s.realRpe)}
      </div>`;
    } else {
      const pctCls = completionColorClass(s.completionPct);
      html += `<div class="recap-section"><h4>Charge prévue vs réelle</h4>
        ${recapRow('Charge Foster', `${s.plannedLoad ?? '–'} prévue → ${isMissed ? '–' : (s.realLoad ?? '–')} réelle`)}
        ${recapRow('RPE', `${s.rpe ?? '–'} prévu → ${isMissed ? '–' : (s.realRpe ?? '–')} réel`)}
        ${!isMissed && s.completionPct != null ? recapRow('% de complétion', `<span class="chip-pct ${pctCls}">${s.completionPct}%</span>`) : ''}
      </div>`;
    }

    if (!isMissed) {
      html += `<div class="recap-section"><h4>Statistiques</h4>
        ${recapRow('Temps', s.realMovingTime ? fmtTime(s.realMovingTime) : null)}
        ${recapRow('Distance', s.realDistanceM ? `${(s.realDistanceM / 1000).toFixed(1)} km` : null)}
        ${recapRow('D+', s.realElevationM ? `${Math.round(s.realElevationM)} m` : null)}
        ${isBike
          ? `${recapRow('Puissance moyenne', s.realAvgWatts != null ? `${s.realAvgWatts} W` : null)}${recapRow('Puissance normalisée', s.realNormPower != null ? `${s.realNormPower} W` : null)}`
          : `${recapRow('Allure moyenne', fmtPaceFromSpeed(s.realAvgSpeedMs))}${recapRow('Puissance moyenne', s.realAvgWatts != null ? `${s.realAvgWatts} W` : null)}`}
        ${recapRow("Note de l'athlète", s.realNote ? escHtml(s.realNote) : null)}
      </div>`;
    } else {
      html += `<p class="caption">Aucune activité réelle enregistrée pour cette séance.</p>`;
    }

    el.recapBody.innerHTML = html;
    el.recapModal.style.display = 'flex';

    // "Analyse avancée" par intervalle : uniquement pour une vraie activité (pas une séance manquée)
    // de type course à pied/trail ou vélo, seuls sports pour lesquels ce détail a du sens ici.
    recapActivityId = !isMissed && s.activityId != null ? s.activityId : null;
    recapSportKey = isBike ? 'Ride' : (sportKey === 'Run' ? 'Run' : null);
    if (el.recapAdvancedBtn) {
      el.recapAdvancedBtn.style.display = recapActivityId && recapSportKey ? '' : 'none';
      el.recapAdvancedBtn.dataset.title = el.recapTitle.textContent;
    }
  }

  function closeRecapModal() {
    el.recapModal.style.display = 'none';
  }

  const INTERVAL_TYPE_CAPTION = (label) => (label ? `<span class="caption">(${escHtml(label)})</span>` : '');

  /** Tableau HTML de l'analyse avancée par intervalle. `sportKey` = 'Ride' masque allure/VAM (sans objet à vélo). */
  function intervalsTableHtml(rows, sportKey) {
    if (!rows || !rows.length) return '<p class="caption">Aucun intervalle détecté pour cette activité.</p>';
    const isBike = sportKey === 'Ride';
    const headers = isBike
      ? ['#', 'Distance', 'Temps', 'D+', 'D-', 'Watts moy.', 'FC moy.', 'FC max']
      : ['#', 'Distance', 'Temps', 'D+', 'D-', 'Allure', 'VAM', 'Watts moy.', 'FC moy.', 'FC max'];
    const body = rows
      .map((r) => {
        const cells = [
          `${r.index} ${INTERVAL_TYPE_CAPTION(r.typeLabel)}`,
          r.distanceM ? `${(r.distanceM / 1000).toFixed(2)} km` : '–',
          r.movingTime ? fmtTime(r.movingTime) : '–',
          r.elevationGainM ? `${Math.round(r.elevationGainM)} m` : '–',
          r.elevationLossM ? `${Math.round(r.elevationLossM)} m` : '–',
        ];
        if (!isBike) {
          cells.push(fmtPaceFromSpeed(r.avgSpeedMs) || '–');
          cells.push(r.vamMh != null ? `${r.vamMh} m/h` : '–');
        }
        cells.push(r.avgWatts != null ? `${r.wattsEstimated ? '~' : ''}${r.avgWatts} W` : '–');
        cells.push(r.avgHr != null ? `${r.avgHr} bpm` : '–');
        cells.push(r.maxHr != null ? `${r.maxHr} bpm` : '–');
        return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
      })
      .join('');
    const hasEstimate = rows.some((r) => r.wattsEstimated);
    const footnote = hasEstimate
      ? '<p class="caption" style="margin-top:6px;">~ : puissance estimée (pas de capteur), à partir du poids, du D+, du temps et de la distance.</p>'
      : '';
    return `<table class="intervals-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>${footnote}`;
  }

  async function openIntervalsModal(activityId, sportKey, title) {
    if (!el.intervalsModal) return;
    el.intervalsTitle.textContent = `Analyse avancée — ${title}`;
    el.intervalsBody.innerHTML = '<p class="caption">Chargement…</p>';
    el.intervalsModal.style.display = 'flex';
    try {
      const qs = new URLSearchParams({ athleteId, sportKey: sportKey || '' }).toString();
      const res = await fetch(`/api/planning/activity/${encodeURIComponent(activityId)}/intervals?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Erreur de chargement.');
      el.intervalsBody.innerHTML = intervalsTableHtml(body.intervals, sportKey);
    } catch (e) {
      el.intervalsBody.innerHTML = `<p class="alert alert-error">${escHtml(e.message)}</p>`;
    }
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
      if (btn) { btn.disabled = false; btn.textContent = 'IA'; }
    }
  }

  /** Remplit une semaine SANS IA, selon des règles fixes appliquées à la vraie bibliothèque
   * Intervals.icu (même contrat que applyAiPlanWeek, sans modale ni commentaire). */
  async function applyDeterministicPlanWeek(week) {
    const state = getWeekState(week);
    const btn = el.monthGrid && el.monthGrid.querySelector(`.cw-det-prefill[data-week="${week}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Auto…'; }

    try {
      const res = await fetch('/api/planning/deterministic-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planningType: state.planningType,
          nRun: state.nRun,
          nBike: state.nBike,
          nStrength: state.nStrength,
          chronicLoad: chronicBeforeWeek(week),
          targetAcwr: defaultTargetAcwrFor(state.planningType),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Échec du remplissage automatique.');

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
        el.sendResult.innerHTML = `<div class="alert alert-info">⚙️ ${escHtml(body.plan.rationale)}</div>`;
      }
    } catch (e) {
      if (el.sendResult) el.sendResult.innerHTML = `<div class="alert alert-error">Erreur : ${escHtml(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Auto'; }
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

  /** Affiche/masque le contenu du graphique de charge (option persistée en localStorage) pour laisser
   * plus de place au calendrier ; le bouton lui-même reste visible pour pouvoir le réafficher.
   * Ne (re)calcule le graphique que s'il redevient visible. */
  function applyChartVisibility() {
    if (el.chartBody) el.chartBody.style.display = chartHidden ? 'none' : '';
    if (el.toggleChartBtn) el.toggleChartBtn.textContent = chartHidden ? '📈 Afficher le graphique' : '📉 Masquer le graphique';
    if (!chartHidden) renderLoadChart();
  }

  async function renderLoadChart() {
    if (chartHidden) return;
    if (!window.Chart) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    const nWeeks = CHART_HORIZON_WEEKS;
    const planWeeks = getPlanWeeks(nWeeks);
    prefetchHorizonMonths(planWeeks); // best-effort ; fetchCalendarMonth rafraîchira tout à réception
    // Semaines réalisées (4 dernières max) : point de départ "comme si rien n'était encore planifié".
    const realized = historicalWeeklyLoads();
    const nRealized = realized.length;
    const projection = projectWeeklyAcwr(planWeeks);

    const latestReal = realized[nRealized - 1];
    if (el.cycleSummary) {
      const parts = [];
      if (chronicData && chronicData.currentWeekActual) parts.push(`Semaine en cours (réel à date) : ${Math.round(chronicData.currentWeekActual.weekly_load)} Foster`);
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
          legend: { display: false },
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

  /** Navigue le calendrier vers le mois d'une semaine donnée et met en évidence sa barre d'actions (utilisé par le clic sur le graphique). */
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

  // ── Event wiring ──────────────────────────────────────────────

  if (el.athleteSelect) {
    el.athleteSelect.addEventListener('change', () => {
      athleteId = el.athleteSelect.value;
      calendarCache = {};
      pendingSessions = [];
      pendingEdits = {};
      pendingDeletes.clear();
      loadChronicData();
      fetchCalendarMonth(currentYear, currentMonth);
      refreshAll();
    });
  }

  el.libSearch.addEventListener('input', () => { searchQuery = el.libSearch.value; renderLibrary(); });
  if (el.folderFilter) el.folderFilter.addEventListener('change', () => { folderFilter = el.folderFilter.value; renderLibrary(); });

  el.libraryCancel.addEventListener('click', closeLibraryModal);
  el.libraryModal.addEventListener('click', (e) => { if (e.target === el.libraryModal) closeLibraryModal(); });
  el.librarySessionLibre.addEventListener('click', () => {
    const date = libraryTargetDate;
    closeLibraryModal();
    if (date) addManualPlanSession(date);
  });

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
  el.exportCsvBtn.addEventListener('click', () => {
    const qs = new URLSearchParams({ athleteId }).toString();
    window.location.href = `/api/planning/export-csv?${qs}`;
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
    const detBtn = e.target.closest('.cw-det-prefill');
    if (detBtn) { applyDeterministicPlanWeek(detBtn.dataset.week); return; }

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
    if (realChip && realChip.dataset.eventId) {
      const status = realChip.dataset.status;
      if (status === 'done' || status === 'missed' || status === 'extra') {
        openRecapModal(realChip.dataset.eventId);
      } else {
        openEditModalForReal(realChip.dataset.eventId);
      }
      return;
    }

    const addBtn = e.target.closest('.plan-add-session');
    if (addBtn) { openLibraryModal(addBtn.dataset.date); return; }
  });

  el.editSave.addEventListener('click', saveEditModal);
  el.editCancel.addEventListener('click', closeEditModal);
  el.editModal.addEventListener('click', (e) => { if (e.target === el.editModal) closeEditModal(); });
  el.editDescription.addEventListener('input', updateEditComputedInfo);
  el.editRpe.addEventListener('input', updateEditComputedInfo);

  if (el.recapClose) el.recapClose.addEventListener('click', closeRecapModal);
  if (el.recapModal) el.recapModal.addEventListener('click', (e) => { if (e.target === el.recapModal) closeRecapModal(); });
  if (el.recapAdvancedBtn) {
    el.recapAdvancedBtn.addEventListener('click', () => {
      if (!recapActivityId || !recapSportKey) return;
      openIntervalsModal(recapActivityId, recapSportKey, el.recapAdvancedBtn.dataset.title || '');
    });
  }
  if (el.intervalsClose) el.intervalsClose.addEventListener('click', () => { el.intervalsModal.style.display = 'none'; });
  if (el.intervalsModal) el.intervalsModal.addEventListener('click', (e) => { if (e.target === el.intervalsModal) el.intervalsModal.style.display = 'none'; });

  if (el.toggleChartBtn) {
    el.toggleChartBtn.addEventListener('click', () => {
      chartHidden = !chartHidden;
      localStorage.setItem('planningChartHidden', chartHidden ? '1' : '0');
      applyChartVisibility();
    });
  }

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

  // ── Init ──────────────────────────────────────────────────────
  renderLibrary();
  loadIntervalsWorkouts();
  renderMonthCalendar();
  fetchCalendarMonth(currentYear, currentMonth);
  applyChartVisibility();

})();
