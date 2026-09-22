/* global Chart, Format */
(function () {
  'use strict';

  const boot = window.__BOOTSTRAP__ || { params: {}, data: null };
  const charts = {}; // registre des instances Chart.js pour destroy/recreate
  let showNotes = false;
  let notesCount = 0;

  const els = {
    athlete: document.getElementById('athleteSelect'),
    historyStart: document.getElementById('historyStart'),
    content: document.getElementById('dashboard-content'),
    toggleNotesBtn: document.getElementById('toggleNotesBtn'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),
  };

  if (!els.content) return; // page en erreur / clé API manquante

  if (els.exportCsvBtn) {
    els.exportCsvBtn.addEventListener('click', () => {
      const qs = new URLSearchParams(currentParams()).toString();
      window.location.href = `/api/dashboard/export-csv?${qs}`;
    });
  }

  if (els.toggleNotesBtn) {
    els.toggleNotesBtn.addEventListener('click', () => {
      showNotes = !showNotes;
      els.toggleNotesBtn.textContent = `${showNotes ? '🗒️ Masquer les notes' : '🗒️ Afficher les notes'} (${notesCount})`;
      Object.values(charts).forEach((c) => c.update('none'));
    });
  }

  const SPORT_COLORS = ['#ff6b35', '#4a90d9', '#a78bfa', '#35c46f', '#f5a623', '#ec4899', '#22d3ee', '#facc15'];
  const ZONE_COLORS = ['#3b82f6', '#eab308', '#ef4444']; // modèle 3 paliers bleu/jaune/rouge (FC + puissance)
  let hrZoneSelection = null; // Set<string> des sports cochés pour le graphique zones FC (null = pas encore initialisé)
  let powerZoneSelection = null; // idem pour le graphique zones de puissance

  // Bandes horizontales colorées pour chaque note Intervals.icu (s'étend jusqu'à la note suivante)
  const NOTE_BAND_COLORS = [
    ['rgba(100,150,255,0.06)', 'rgba(100,150,255,0.30)'],
    ['rgba(255,170,80,0.06)', 'rgba(255,170,80,0.30)'],
    ['rgba(80,220,130,0.06)', 'rgba(80,220,130,0.30)'],
    ['rgba(220,80,80,0.06)', 'rgba(220,80,80,0.30)'],
    ['rgba(200,100,255,0.06)', 'rgba(200,100,255,0.30)'],
  ];
  const notePlugin = {
    id: 'noteLines',
    afterDraw(chart) {
      if (!showNotes) return;
      const notes = chart.options.plugins.noteLines?.notes;
      if (!notes || !notes.length) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      ctx.save();
      ctx.font = '10px sans-serif';
      notes.forEach((note, idx) => {
        const x1 = xScale.getPixelForValue(new Date(note.date).getTime());
        const next = notes[idx + 1];
        const x2 = next ? xScale.getPixelForValue(new Date(next.date).getTime()) : chartArea.right;
        if (x2 < chartArea.left || x1 > chartArea.right) return;
        const sx = Math.max(x1, chartArea.left);
        const ex = Math.min(x2, chartArea.right);
        const [fill, border] = NOTE_BAND_COLORS[idx % NOTE_BAND_COLORS.length];
        ctx.fillStyle = fill;
        ctx.fillRect(sx, chartArea.top, ex - sx, chartArea.bottom - chartArea.top);
        ctx.beginPath();
        ctx.moveTo(sx, chartArea.top);
        ctx.lineTo(sx, chartArea.bottom);
        ctx.strokeStyle = border;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const bandWidth = ex - sx - 8;
        if (bandWidth > 10) {
          ctx.fillStyle = border;
          // Couper le texte en mots et empiler les lignes dans la largeur disponible
          const words = note.name.split(' ');
          let line = '';
          let lineY = chartArea.top + 12;
          for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > bandWidth && line) {
              ctx.fillText(line, sx + 4, lineY);
              line = word;
              lineY += 13;
            } else {
              line = test;
            }
          }
          if (line) ctx.fillText(line, sx + 4, lineY);
        }
      });
      ctx.restore();
    },
  };
  Chart.register(notePlugin);

  function colorFor(i) {
    return SPORT_COLORS[i % SPORT_COLORS.length];
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function currentParams() {
    const params = {
      athleteId: els.athlete.value,
      historyStart: els.historyStart.value,
    };
    if (boot.widgetToken) params.token = boot.widgetToken;
    return params;
  }

  async function fetchData(params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/api/dashboard-data?${qs}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erreur inconnue' }));
      throw new Error(err.error || 'Erreur inconnue');
    }
    return res.json();
  }

  const onFilterChange = debounce(async () => {
    try {
      const data = await fetchData(currentParams());
      render(data, false);
    } catch (e) {
      els.content.innerHTML = `<div class="alert alert-error">${e.message}</div>`;
    }
  }, 350);

  [els.athlete, els.historyStart].forEach((el) => el.addEventListener('change', onFilterChange));

  function destroyChart(id) {
    if (charts[id]) {
      charts[id].destroy();
      delete charts[id];
    }
  }

  function baseTimeScale(extra) {
    return Object.assign(
      {
        type: 'time',
        time: { unit: 'day', tooltipFormat: 'dd/MM/yyyy' },
        ticks: { color: '#8a91a3', maxRotation: 0 },
        grid: { color: '#232838' },
      },
      extra || {}
    );
  }

  // ------------------------------------------------------------
  // KPIs
  // ------------------------------------------------------------
  const KPI_ICON = {
    flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 17a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7.5 7.5 0 1 1-15 0c0-1.153.433-2.294 1-3 1.464-1.85 2.5-3.5 2.5-3.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
    mountain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><path d="m9 15 2 2 4-4"/></svg>',
  };

  function renderKpis(data) {
    const k = data.kpis;
    const items = [
      { icon: 'flame', color: 'var(--accent)', label: 'Charge Foster', value: Math.round(k.totalLoad) },
      { icon: 'clock', color: 'var(--accent-2)', label: 'Temps', value: k.totalTimeFmt },
      { icon: 'mountain', color: 'var(--green)', label: 'D+', value: `${Math.round(k.totalDplus)} m` },
      { icon: 'check', color: 'var(--orange)', label: 'Séances', value: k.sessions },
    ];
    return `
      <div class="kpis">
        ${items
          .map(
            (it) => `
          <div class="kpi">
            <div class="kpi-icon" style="--kpi-color:${it.color}">${KPI_ICON[it.icon]}</div>
            <div>
              <div class="label">${it.label}</div>
              <div class="value">${it.value}</div>
            </div>
          </div>`
          )
          .join('')}
      </div>`;
  }

  // ------------------------------------------------------------
  // Graphique 1 — Charge Foster par sport
  // ------------------------------------------------------------
  function renderSportFosterChart(data) {
    destroyChart('sportFoster');
    const ctx = document.getElementById('chart-sport-foster').getContext('2d');
    const c = data.sportFosterChart;

    const datasets = c.sports.map((s, i) => ({
      type: 'bar',
      label: s.name,
      data: c.dates.map((d, idx) => ({ x: d, y: s.values[idx] })),
      backgroundColor: colorFor(i),
      stack: 'sport',
    }));

    datasets.push({
      type: 'line',
      label: 'Foster 7j',
      data: c.roll7.dates.map((d, idx) => ({ x: d, y: c.roll7.values[idx] })),
      borderColor: '#ffffff',
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.15,
      yAxisID: 'y',
    });

    if (c.planRoll7.dates.length) {
      datasets.push({
        type: 'line',
        label: 'Foster 7j planifié',
        data: c.planRoll7.dates.map((d, idx) => ({ x: d, y: c.planRoll7.values[idx] })),
        borderColor: '#f5a623',
        borderDash: [6, 4],
        borderWidth: 2,
        pointRadius: 0,
        yAxisID: 'y',
      });
    }

    charts.sportFoster = new Chart(ctx, {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: baseTimeScale(),
          y: { stacked: true, title: { display: true, text: 'Charge Foster', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
        },
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          noteLines: { notes: data.notes || [] },
        },
      },
    });

    if (c.roll7.last) {
      document.getElementById('sport-foster-caption').textContent =
        `Charge 7 jours glissants au ${formatFr(c.roll7.last.date)} : ${Math.round(c.roll7.last.load_7d)}`;
    } else {
      document.getElementById('sport-foster-caption').textContent = '';
    }
  }

  function formatFr(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  // ------------------------------------------------------------
  // Graphique 2 — CAP (km / D+ / heures)
  // ------------------------------------------------------------
  function renderCapChart(data) {
    destroyChart('cap');
    const el = document.getElementById('chart-cap');
    const empty = document.getElementById('cap-empty');
    const c = data.capChart;
    if (!c.weeks.length) {
      el.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    el.style.display = 'block';
    empty.style.display = 'none';

    const datasets = [
      {
        type: 'bar',
        label: 'Km',
        data: c.weeks.map((w, i) => ({ x: w, y: c.km[i] })),
        backgroundColor: '#FF6B35',
        stack: 'run',
        yAxisID: 'y',
      },
      {
        type: 'bar',
        label: 'D+ (m)',
        data: c.weeks.map((w, i) => ({ x: w, y: c.dplusScaled[i], dplus: c.dplus[i] })),
        backgroundColor: '#8B4513',
        stack: 'run',
        yAxisID: 'y',
      },
      {
        type: 'line',
        label: 'Heures',
        data: c.weeks.map((w, i) => ({ x: w, y: c.heures[i] })),
        borderColor: '#1F77B4',
        borderWidth: 3,
        pointRadius: 3,
        yAxisID: 'y2',
      },
    ];

    if (c.plannedWeeks.length) {
      datasets.push({
        type: 'line',
        label: 'Heures planifiées',
        data: c.plannedWeeks.map((w, i) => ({ x: w, y: c.plannedHeures[i], race: (c.plannedRaces || [])[i] })),
        borderColor: '#1F77B4',
        borderDash: [6, 4],
        borderWidth: 2,
        pointStyle: 'circle',
        pointRadius: 4,
        pointBackgroundColor: 'transparent',
        yAxisID: 'y2',
      });
    }

    charts.cap = new Chart(el.getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'x', intersect: false },
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          noteLines: { notes: data.notes || [] },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label === 'D+ (m)') return `D+ : ${Math.round(ctx.raw.dplus || 0)} m`;
                if (ctx.dataset.label === 'Km') return `Km : ${ctx.raw.y.toFixed(1)}`;
                if (ctx.dataset.label === 'Heures planifiées' && ctx.raw.race) {
                  return [`Heures planifiées : ${ctx.raw.y.toFixed(2)}`, `🏁 ${ctx.raw.race}`];
                }
                return `${ctx.dataset.label} : ${ctx.raw.y.toFixed(2)}`;
              },
            },
          },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { stacked: true, position: 'left', title: { display: true, text: `Km / D+ (÷${c.dplusScale})`, color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
          y2: { display: false, position: 'right', title: { display: false, text: 'Heures' } },
        },
      },
    });
  }

  // ------------------------------------------------------------
  // Graphique 3 — Vélo (km / D+ / heures / kJ)
  // ------------------------------------------------------------
  function renderBikeChart(data) {
    destroyChart('bike');
    const el = document.getElementById('chart-bike');
    const empty = document.getElementById('bike-empty');
    const c = data.bikeChart;
    if (!c.weeks.length) {
      el.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    el.style.display = 'block';
    empty.style.display = 'none';

    const datasets = [
      {
        type: 'bar',
        label: 'Km',
        data: c.weeks.map((w, i) => ({ x: w, y: c.km[i] })),
        backgroundColor: '#4A90D9',
        stack: 'bike',
        yAxisID: 'y',
      },
      {
        type: 'bar',
        label: 'D+ (m)',
        data: c.weeks.map((w, i) => ({ x: w, y: c.dplusScaled[i], dplus: c.dplus[i] })),
        backgroundColor: '#2C5F8A',
        stack: 'bike',
        yAxisID: 'y',
      },
      {
        type: 'line',
        label: 'Heures',
        data: c.weeks.map((w, i) => ({ x: w, y: c.heures[i] })),
        borderColor: '#F5A623',
        borderWidth: 3,
        pointRadius: 3,
        yAxisID: 'y2',
      },
      {
        type: 'line',
        label: 'kJ',
        data: c.weeks.map((w, i) => ({ x: w, y: c.kj[i] })),
        borderColor: '#7B2D8E',
        borderDash: [3, 3],
        borderWidth: 3,
        pointRadius: 3,
        yAxisID: 'y3',
      },
    ];

    if (c.plannedWeeks.length) {
      datasets.push({
        type: 'line',
        label: 'Heures planifiées',
        data: c.plannedWeeks.map((w, i) => ({ x: w, y: c.plannedHeures[i], race: (c.plannedRaces || [])[i] })),
        borderColor: '#F5A623',
        borderDash: [6, 4],
        borderWidth: 2,
        pointStyle: 'circle',
        pointRadius: 4,
        pointBackgroundColor: 'transparent',
        yAxisID: 'y2',
      });
    }

    charts.bike = new Chart(el.getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'x', intersect: false },
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          noteLines: { notes: data.notes || [] },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label === 'D+ (m)') return `D+ : ${Math.round(ctx.raw.dplus || 0)} m`;
                if (ctx.dataset.label === 'Km') return `Km : ${ctx.raw.y.toFixed(1)}`;
                if (ctx.dataset.label === 'Heures planifiées' && ctx.raw.race) {
                  return [`Heures planifiées : ${ctx.raw.y.toFixed(2)}`, `🏁 ${ctx.raw.race}`];
                }
                return `${ctx.dataset.label} : ${ctx.raw.y.toFixed(1)}`;
              },
            },
          },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { stacked: true, position: 'left', title: { display: true, text: `Km / D+ (÷${c.dplusScale})`, color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
          y2: { display: false, position: 'right', title: { display: false, text: 'Heures' } },
          y3: { display: false, position: 'right', title: { display: false, text: 'kJ' } },
        },
      },
    });
  }

  // ------------------------------------------------------------
  // Graphique — TRIMP hebdomadaire (2e mesure de charge, complément du Foster/sRPE) + planifié
  // ------------------------------------------------------------
  function renderTrimpChart(data) {
    destroyChart('trimp');
    const c = data.trimpChart;
    const el = document.getElementById('chart-trimp');
    const datasets = [
      {
        type: 'bar',
        label: 'TRIMP',
        data: c.weeks.map((w, i) => ({ x: w, y: c.trimp[i] })),
        backgroundColor: '#a78bfa',
      },
    ];
    if (c.plannedTrimp.some((v) => v != null)) {
      datasets.push({
        type: 'bar',
        label: 'TRIMP planifié (estimé)',
        data: c.weeks.map((w, i) => ({ x: w, y: c.plannedTrimp[i] })),
        backgroundColor: 'rgba(167,139,250,0.35)',
      });
    }
    charts.trimp = new Chart(el.getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          tooltip: { callbacks: { label: (ctx) => (ctx.raw.y != null ? `${ctx.dataset.label} : ${Math.round(ctx.raw.y)}` : null) } },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { title: { display: true, text: 'TRIMP / semaine', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
        },
      },
    });
  }

  // ------------------------------------------------------------
  // Graphique — Temps hebdomadaire dans les zones FC (barres empilées, filtrable par sport)
  // ------------------------------------------------------------
  function zoneLabelsFor(zoneIds, bounds, unit) {
    if (!Array.isArray(bounds) || bounds.length !== zoneIds.length) return zoneIds;
    return zoneIds.map((id, i) => {
      const lo = i === 0 ? 0 : bounds[i - 1];
      const hi = bounds[i];
      return i === zoneIds.length - 1 ? `${id} (${lo}+ ${unit})` : `${id} (${lo}-${hi} ${unit})`;
    });
  }

  function drawHrZoneChart(data) {
    destroyChart('hrZone');
    const c = data.hrZoneChart;
    const el = document.getElementById('chart-hrzone');
    const selected = hrZoneSelection || new Set(c.sports);

    const byWeek = new Map(c.weeks.map((w) => [w, c.zoneIds.map(() => 0)]));
    for (const r of c.rows) {
      if (!selected.has(r.sport)) continue;
      const arr = byWeek.get(r.week);
      if (!arr) continue;
      r.minutes.forEach((m, i) => { arr[i] += m; });
    }
    const weekTotals = new Map([...byWeek.entries()].map(([w, arr]) => [w, arr.reduce((s, v) => s + v, 0)]));

    const zoneLabels = zoneLabelsFor(c.zoneIds, c.zoneBounds, 'bpm');
    const datasets = c.zoneIds.map((id, i) => ({
      type: 'bar',
      label: zoneLabels[i],
      data: c.weeks.map((w) => {
        const minutes = byWeek.get(w)[i];
        const total = weekTotals.get(w);
        return { x: w, y: Math.round((minutes / 60) * 10) / 10, pct: total > 0 ? Math.round((minutes / total) * 100) : 0 };
      }),
      backgroundColor: ZONE_COLORS[i % ZONE_COLORS.length],
      stack: 'zones',
    }));

    charts.hrZone = new Chart(el.getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label} : ${ctx.raw.y.toFixed(1)} h (${ctx.raw.pct}%)` } },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { stacked: true, title: { display: true, text: 'Heures / semaine', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
        },
      },
    });
  }

  function renderHrZoneChart(data) {
    const c = data.hrZoneChart;
    const wrap = document.getElementById('hrzone-wrap');
    const empty = document.getElementById('hrzone-empty');
    const filtersEl = document.getElementById('hrzone-filters');

    if (!c.sports.length) {
      wrap.style.display = 'none';
      filtersEl.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    wrap.style.display = 'block';
    filtersEl.style.display = 'flex';
    empty.style.display = 'none';

    if (!hrZoneSelection) hrZoneSelection = new Set(c.sports);
    else {
      hrZoneSelection = new Set([...hrZoneSelection].filter((s) => c.sports.includes(s)));
      if (!hrZoneSelection.size) hrZoneSelection = new Set(c.sports);
    }

    filtersEl.innerHTML = c.sports
      .map(
        (s) =>
          `<label><input type="checkbox" class="hrzone-sport" value="${escapeHtml(s)}" ${hrZoneSelection.has(s) ? 'checked' : ''}/> ${escapeHtml(s)}</label>`
      )
      .join('');
    filtersEl.querySelectorAll('.hrzone-sport').forEach((cb) => {
      cb.addEventListener('change', () => {
        const checked = [...filtersEl.querySelectorAll('.hrzone-sport:checked')].map((x) => x.value);
        hrZoneSelection = new Set(checked.length ? checked : c.sports);
        drawHrZoneChart(data);
      });
    });

    drawHrZoneChart(data);
  }

  // ------------------------------------------------------------
  // Graphique — Temps hebdomadaire dans les zones de puissance (vélo mesuré, CAP estimée)
  // ------------------------------------------------------------
  function drawPowerZoneChart(data) {
    destroyChart('powerZone');
    const c = data.powerZoneChart;
    const el = document.getElementById('chart-powerzone');
    const selected = powerZoneSelection || new Set(c.sports);

    const byWeek = new Map(c.weeks.map((w) => [w, c.zoneIds.map(() => 0)]));
    for (const r of c.rows) {
      if (!selected.has(r.sport)) continue;
      const arr = byWeek.get(r.week);
      if (!arr) continue;
      r.minutes.forEach((m, i) => { arr[i] += m; });
    }
    const weekTotals = new Map([...byWeek.entries()].map(([w, arr]) => [w, arr.reduce((s, v) => s + v, 0)]));

    const zoneLabels = zoneLabelsFor(c.zoneIds, c.wattBounds, 'W');
    const datasets = c.zoneIds.map((id, i) => ({
      type: 'bar',
      label: zoneLabels[i],
      data: c.weeks.map((w) => {
        const minutes = byWeek.get(w)[i];
        const total = weekTotals.get(w);
        return { x: w, y: Math.round((minutes / 60) * 10) / 10, pct: total > 0 ? Math.round((minutes / total) * 100) : 0 };
      }),
      backgroundColor: ZONE_COLORS[i % ZONE_COLORS.length],
      stack: 'zones',
    }));

    charts.powerZone = new Chart(el.getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label} : ${ctx.raw.y.toFixed(1)} h (${ctx.raw.pct}%)` } },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { stacked: true, title: { display: true, text: 'Heures / semaine', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
        },
      },
    });
  }

  function renderPowerZoneChart(data) {
    const c = data.powerZoneChart;
    const wrap = document.getElementById('powerzone-wrap');
    const empty = document.getElementById('powerzone-empty');
    const filtersEl = document.getElementById('powerzone-filters');

    if (!c.sports.length) {
      wrap.style.display = 'none';
      filtersEl.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    wrap.style.display = 'block';
    filtersEl.style.display = 'flex';
    empty.style.display = 'none';

    if (!powerZoneSelection) powerZoneSelection = new Set(c.sports);
    else {
      powerZoneSelection = new Set([...powerZoneSelection].filter((s) => c.sports.includes(s)));
      if (!powerZoneSelection.size) powerZoneSelection = new Set(c.sports);
    }

    filtersEl.innerHTML = c.sports
      .map(
        (s) =>
          `<label><input type="checkbox" class="powerzone-sport" value="${escapeHtml(s)}" ${powerZoneSelection.has(s) ? 'checked' : ''}/> ${escapeHtml(s)}</label>`
      )
      .join('');
    filtersEl.querySelectorAll('.powerzone-sport').forEach((cb) => {
      cb.addEventListener('change', () => {
        const checked = [...filtersEl.querySelectorAll('.powerzone-sport:checked')].map((x) => x.value);
        powerZoneSelection = new Set(checked.length ? checked : c.sports);
        drawPowerZoneChart(data);
      });
    });

    drawPowerZoneChart(data);
  }

  // ------------------------------------------------------------
  // Graphiques — Efficiency Factor hebdomadaire (Vélo : puissance/FC, CAP : GAP/FC)
  // ------------------------------------------------------------
  function renderEfficiencyChart(data) {
    destroyChart('efBike');
    destroyChart('efRun');
    const c = data.efficiencyChart;

    charts.efBike = new Chart(document.getElementById('chart-ef-bike').getContext('2d'), {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'EF Vélo (puissance/FC)',
            data: c.weeks.map((w, i) => ({ x: w, y: c.bike[i] })),
            borderColor: '#4a90d9',
            borderWidth: 3,
            pointRadius: 3,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          tooltip: { callbacks: { label: (ctx) => `EF : ${ctx.raw.y != null ? ctx.raw.y.toFixed(2) : '—'} W/bpm` } },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { title: { display: true, text: 'W / bpm', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
        },
      },
    });

    charts.efRun = new Chart(document.getElementById('chart-ef-run').getContext('2d'), {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'EF CAP (GAP/FC)',
            data: c.weeks.map((w, i) => ({ x: w, y: c.run[i] })),
            borderColor: '#ff6b35',
            borderWidth: 3,
            pointRadius: 3,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#eef0f4' } },
          tooltip: { callbacks: { label: (ctx) => `EF : ${ctx.raw.y != null ? ctx.raw.y.toFixed(3) : '—'} m/s/bpm` } },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { title: { display: true, text: 'm/s / bpm', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
        },
      },
    });
  }

  // ------------------------------------------------------------
  // Graphique — HRV + FC de repos quotidiennes, moyenne mobile 7j + analyse de tendance descriptive
  // ------------------------------------------------------------
  function wellnessTrendPill(trend) {
    if (!trend) return '';
    const cls = { hrvDown: 'pill-orange', rhrUp: 'pill-orange', both: 'pill-red', returning: 'pill-green', normal: 'pill-green' }[trend.status] || 'pill-orange';
    return `<span class="pill ${cls}">${escapeHtml(trend.message)}</span>`;
  }

  function renderWellnessChart(data) {
    destroyChart('wellness');
    const c = data.wellnessChart;
    const wrap = document.getElementById('wellness-wrap');
    const empty = document.getElementById('wellness-empty');
    const caption = document.getElementById('wellness-caption');

    if (!c.dates.length) {
      wrap.style.display = 'none';
      empty.style.display = 'block';
      caption.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    empty.style.display = 'none';
    caption.innerHTML = wellnessTrendPill(c.trend);

    const datasets = [
      {
        type: 'line',
        label: 'HRV',
        data: c.dates.map((d, i) => ({ x: d, y: c.hrv[i] })),
        borderColor: 'rgba(74,144,217,0.5)',
        backgroundColor: 'rgba(74,144,217,0.5)',
        pointRadius: 2,
        borderWidth: 0,
        showLine: false,
        spanGaps: false,
        yAxisID: 'yHrv',
      },
      {
        type: 'line',
        label: 'HRV (moy. 7j)',
        data: c.dates.map((d, i) => ({ x: d, y: c.hrvRoll7[i] })),
        borderColor: '#4a90d9',
        borderWidth: 3,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: 'yHrv',
      },
      {
        type: 'line',
        label: 'FC repos',
        data: c.dates.map((d, i) => ({ x: d, y: c.rhr[i] })),
        borderColor: 'rgba(239,87,87,0.5)',
        backgroundColor: 'rgba(239,87,87,0.5)',
        pointRadius: 2,
        borderWidth: 0,
        showLine: false,
        spanGaps: false,
        yAxisID: 'yRhr',
      },
      {
        type: 'line',
        label: 'FC repos (moy. 7j)',
        data: c.dates.map((d, i) => ({ x: d, y: c.rhrRoll7[i] })),
        borderColor: '#ef5757',
        borderWidth: 3,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: 'yRhr',
      },
    ];

    charts.wellness = new Chart(document.getElementById('chart-wellness').getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#eef0f4' } } },
        scales: {
          x: baseTimeScale(),
          yHrv: { position: 'left', title: { display: true, text: 'HRV (ms)', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
          yRhr: { position: 'right', title: { display: true, text: 'FC repos (bpm)', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { drawOnChartArea: false }, afterFit(s) { s.width = 70; } },
        },
      },
    });
  }

  // ------------------------------------------------------------
  // Graphique 4 — ACWR
  // ------------------------------------------------------------
  function renderAcwrChart(data) {
    destroyChart('acwr');
    const el = document.getElementById('chart-acwr');
    const c = data.acwrChart;

    // Zone verte étendue à toutes les semaines (historique + prévisionnel)
    const allBandWeeks = [...new Set([...c.weeks, ...c.forecast.weeks])].sort();
    const bandBottom = allBandWeeks.length
      ? { type: 'line', label: '', data: allBandWeeks.map((w) => ({ x: w, y: 1.0 })), borderColor: '#666', borderDash: [4, 4], borderWidth: 1, pointRadius: 0, order: 10 }
      : null;
    const bandTop = allBandWeeks.length
      ? {
          type: 'line',
          label: 'Zone 1,0 – 1,3',
          data: allBandWeeks.map((w) => ({ x: w, y: 1.3 })),
          borderColor: '#666',
          borderDash: [4, 4],
          borderWidth: 1,
          pointRadius: 0,
          backgroundColor: 'rgba(53,196,111,0.12)',
          fill: '-1',
          order: 10,
        }
      : null;

    const datasets = [];

    const wl = c.weeklyLoad || { weeks: [], real: [], planned: [], plannedTotal: [], currentWeek: null };
    // Échelle des barres réduite (axe étiré) pour qu'elles restent en arrière-plan sans écraser la ligne ACWR.
    const maxStack = wl.weeks.length ? Math.max(...wl.weeks.map((w, i) => (wl.real[i] || 0) + (wl.planned[i] || 0))) : 0;
    if (wl.weeks.length) {
      datasets.push({
        type: 'bar',
        label: 'Charge réelle',
        data: wl.weeks.map((w, i) => ({ x: w, y: wl.real[i] })),
        backgroundColor: 'rgba(53,196,111,0.55)',
        stack: 'weeklyLoad',
        yAxisID: 'yLoad',
        order: -1,
      });
      datasets.push({
        type: 'bar',
        label: 'Charge planifiée',
        data: wl.weeks.map((w, i) => ({ x: w, y: wl.planned[i] })),
        backgroundColor: 'rgba(245,166,35,0.45)',
        stack: 'weeklyLoad',
        yAxisID: 'yLoad',
        order: -1,
      });
    }

    if (bandBottom) datasets.push(bandBottom);
    if (bandTop) datasets.push(bandTop);

    datasets.push({
      type: 'line',
      label: 'ACWR',
      data: c.weeks.map((w, i) => ({ x: w, y: c.acwr[i] })),
      borderColor: '#4a90d9',
      borderWidth: 3,
      pointRadius: 3,
      spanGaps: true,
      yAxisID: 'y',
    });

    if (c.forecast.weeks.length) {
      datasets.push({
        type: 'line',
        label: 'ACWR prévisionnel',
        data: c.forecast.weeks.map((w, i) => ({ x: w, y: c.forecast.acwr[i] })),
        borderColor: '#f5a623',
        borderDash: [6, 4],
        borderWidth: 2,
        pointStyle: 'circle',
        pointRadius: 5,
        pointBackgroundColor: 'transparent',
        spanGaps: true,
      });
    }

    if (c.raceMarkers.length) {
      datasets.push({
        type: 'scatter',
        label: 'Course',
        data: c.raceMarkers.map((r) => ({ x: r.week, y: r.acwr, name: r.name })),
        backgroundColor: '#ef5757',
        borderColor: '#ef5757',
        pointStyle: 'star',
        pointRadius: 9,
      });
    }

    charts.acwr = new Chart(el.getContext('2d'), {
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#eef0f4', filter: (item) => item.text !== '' } },
          noteLines: { notes: data.notes || [] },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label === 'Course') return `Course : ${ctx.raw.name} (ACWR ${ctx.raw.y.toFixed(2)})`;
                if (ctx.dataset.label === 'Charge réelle' || ctx.dataset.label === 'Charge planifiée') {
                  return `${ctx.dataset.label} : ${Math.round(ctx.raw.y || 0)}`;
                }
                return `${ctx.dataset.label} : ${ctx.raw.y != null ? ctx.raw.y.toFixed(2) : '—'}`;
              },
              // Sur la semaine en cours, détaille planifié total / restant / projeté pour suivre
              // en direct si la trajectoire réelle reste alignée avec ce qui était prévu.
              afterBody: (items) => {
                const it = items[0];
                if (!it || (it.dataset.label !== 'Charge réelle' && it.dataset.label !== 'Charge planifiée')) return [];
                const week = it.raw.x;
                if (!wl.currentWeek || week !== wl.currentWeek) return [];
                const idx = wl.weeks.indexOf(week);
                if (idx === -1) return [];
                const real = wl.real[idx] || 0;
                const remaining = wl.planned[idx] || 0;
                const total = (wl.plannedTotal && wl.plannedTotal[idx]) || 0;
                const projected = real + remaining;
                return [
                  '',
                  `Charge planifiée totale (semaine) : ${Math.round(total)}`,
                  `Charge planifiée restante : ${Math.round(remaining)}`,
                  `Charge projetée (restante + réelle) : ${Math.round(projected)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: baseTimeScale({ time: { unit: 'week', tooltipFormat: 'dd/MM/yyyy' } }),
          y: { title: { display: true, text: 'ACWR', color: '#8a91a3' }, ticks: { color: '#8a91a3' }, grid: { color: '#232838' }, afterFit(s) { s.width = 70; } },
          yLoad: {
            stacked: true,
            position: 'right',
            beginAtZero: true,
            max: maxStack > 0 ? maxStack * 3 : undefined,
            title: { display: true, text: 'Charge Foster / semaine', color: '#8a91a3' },
            ticks: { color: '#8a91a3' },
            grid: { drawOnChartArea: false },
            afterFit(s) { s.width = 70; },
          },
        },
      },
    });
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function chronicLoadCaption(c) {
    if (c.currentChronicLoad == null) return '';
    return `<span class="pill pill-green">Charge chronique ${Math.round(c.currentChronicLoad)}</span>`;
  }

  // ------------------------------------------------------------
  // Rendu global
  // ------------------------------------------------------------
  function render(data, isInitial) {
    if (data.empty) {
      els.content.innerHTML = `<div class="alert alert-warning">${data.message}</div>`;
      return;
    }

    els.content.innerHTML = `
      ${renderKpis(data)}

      <div class="grid-2">
        <div class="card">
          <h3 class="card-title">ACWR — Acute:Chronic Workload Ratio</h3>
          <div class="chart-wrap"><canvas id="chart-acwr"></canvas></div>
          <p class="caption">${chronicLoadCaption(data.acwrChart)}</p>
        </div>
        <div class="card">
          <h3 class="card-title">Charge Foster — répartition par sport</h3>
          <div class="chart-wrap"><canvas id="chart-sport-foster"></canvas></div>
          <p class="caption" id="sport-foster-caption"></p>
        </div>
      </div>

      <details class="expander">
        <summary>📖 Comment interpréter ACWR ?</summary>
        <p>L'ACWR compare la charge récente à ta charge habituelle.</p>
        <p><strong>ACWR = charge de la semaine / charge chronique</strong></p>
        <p>La charge chronique correspond à la moyenne des semaines précédentes, avec un maximum de 4 semaines.</p>
        <p>En dessous de 4 semaines d'historique, l'ACWR n'est pas affiché (pas assez de recul) — seules les barres de charge Foster hebdomadaire (réelle / planifiée) restent visibles.</p>
        <table>
          <thead><tr><th>ACWR</th><th>Lecture pratique</th></tr></thead>
          <tbody>
            <tr><td>&lt; 0,8</td><td>Charge nettement inférieure à l'habitude</td></tr>
            <tr><td>0,8 – 1,0</td><td>Charge plutôt basse</td></tr>
            <tr><td><strong>1,0 – 1,3</strong></td><td><strong>Zone de référence affichée sur le graphique</strong></td></tr>
            <tr><td>1,3 – 1,5</td><td>Hausse importante → vigilance</td></tr>
            <tr><td>&gt; 1,5</td><td>Pic de charge → vigilance importante</td></tr>
          </tbody>
        </table>
        <p>Une semaine de récupération avec un ACWR faible est normale et peut être parfaitement souhaitable dans une planification trail.</p>
      </details>

      <div class="grid-2">
        <div class="card">
          <h3 class="card-title">TRIMP hebdomadaire</h3>
          <div class="chart-wrap"><canvas id="chart-trimp"></canvas></div>
          <p class="caption">2e mesure de charge, en complément du Foster/sRPE. Barres claires = TRIMP planifié estimé (pas de FC prévisionnelle réelle).</p>
        </div>
        <div class="card">
          <h3 class="card-title">HRV et FC de repos quotidiennes</h3>
          <div class="chart-wrap" id="wellness-wrap"><canvas id="chart-wellness"></canvas></div>
          <p class="alert alert-info" id="wellness-empty" style="display:none;">Aucune donnée HRV / FC de repos disponible sur la période sélectionnée (nécessite un capteur synchronisé sur Intervals.icu).</p>
          <p class="caption" id="wellness-caption"></p>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 class="card-title">CAP — Km, D+ et heures hebdomadaires</h3>
          <div class="chart-wrap"><canvas id="chart-cap"></canvas></div>
          <p class="alert alert-info" id="cap-empty" style="display:none;">Aucune activité CAP sur la période sélectionnée.</p>
        </div>
        <div class="card">
          <h3 class="card-title">Vélo — Km, D+, heures et kJ hebdomadaires</h3>
          <div class="chart-wrap"><canvas id="chart-bike"></canvas></div>
          <p class="alert alert-info" id="bike-empty" style="display:none;">Aucune activité vélo sur la période sélectionnée.</p>
        </div>
      </div>

      <h2 class="subheader">Efficiency Factor hebdomadaire</h2>
      <div class="grid-2">
        <div class="card">
          <div class="chart-wrap"><canvas id="chart-ef-bike"></canvas></div>
          <p class="caption">Vélo : puissance moyenne / FC moyenne.</p>
        </div>
        <div class="card">
          <div class="chart-wrap"><canvas id="chart-ef-run"></canvas></div>
          <p class="caption">CAP : GAP / FC moyenne.</p>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3 class="card-title">Temps hebdomadaire dans les zones FC</h3>
          <div class="checkbox-group" id="hrzone-filters"></div>
          <div class="chart-wrap" id="hrzone-wrap"><canvas id="chart-hrzone"></canvas></div>
          <p class="alert alert-info" id="hrzone-empty" style="display:none;">Aucune donnée de zones FC sur la période sélectionnée.</p>
        </div>
        <div class="card">
          <h3 class="card-title">Temps hebdomadaire dans les zones de puissance — Vélo</h3>
          <div class="checkbox-group" id="powerzone-filters"></div>
          <div class="chart-wrap" id="powerzone-wrap"><canvas id="chart-powerzone"></canvas></div>
          <p class="alert alert-info" id="powerzone-empty" style="display:none;">Aucune donnée de puissance sur la période sélectionnée.</p>
        </div>
      </div>

      <hr class="sep" />
      <p class="caption">Foster = icu_rpe × moving_time (minutes).</p>
    `;

    renderSportFosterChart(data);
    renderTrimpChart(data);
    renderHrZoneChart(data);
    renderPowerZoneChart(data);
    renderCapChart(data);
    renderBikeChart(data);
    renderEfficiencyChart(data);
    renderWellnessChart(data);
    renderAcwrChart(data);

    if (els.toggleNotesBtn) {
      notesCount = data.notes ? data.notes.length : 0;
      els.toggleNotesBtn.style.display = notesCount ? '' : 'none';
      if (!notesCount) showNotes = false;
      els.toggleNotesBtn.textContent = `${showNotes ? '🗒️ Masquer les notes' : '🗒️ Afficher les notes'} (${notesCount})`;
    }
  }

  // Démarrage
  if (boot.data) {
    render(boot.data, true);
  } else {
    els.content.innerHTML = '<div class="alert alert-info">Chargement…</div>';
    fetchData(currentParams())
      .then((d) => render(d, true))
      .catch((e) => (els.content.innerHTML = `<div class="alert alert-error">${e.message}</div>`));
  }
})();
