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
  };

  if (!els.content) return; // page en erreur / clé API manquante

  if (els.toggleNotesBtn) {
    els.toggleNotesBtn.addEventListener('click', () => {
      showNotes = !showNotes;
      els.toggleNotesBtn.textContent = `${showNotes ? '🗒️ Masquer les notes' : '🗒️ Afficher les notes'} (${notesCount})`;
      Object.values(charts).forEach((c) => c.update('none'));
    });
  }

  const SPORT_COLORS = ['#ff6b35', '#4a90d9', '#a78bfa', '#35c46f', '#f5a623', '#ec4899', '#22d3ee', '#facc15'];

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

  // ------------------------------------------------------------
  // Table détail des séances + debug
  // ------------------------------------------------------------
  function renderSessionsTable(data) {
    const rows = data.sessionsTable
      .map(
        (s) => `<tr>
          <td>${formatFr(s.date)}</td>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.type)}</td>
          <td>${s.temps}</td>
          <td>${s.rpe ?? ''}</td>
          <td>${s.chargeFoster}</td>
          <td>${s.dplus}</td>
          <td>${s.distanceKm}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Nom</th><th>Type</th><th>Temps</th><th>RPE</th><th>Charge Foster</th><th>D+</th><th>Distance km</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8">Aucune séance.</td></tr>'}</tbody>
        </table>
      </div>`;
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

      <h2 class="subheader">ACWR — Acute:Chronic Workload Ratio</h2>
      <div class="card">
        <div class="chart-wrap"><canvas id="chart-acwr"></canvas></div>
        <p class="caption">${chronicLoadCaption(data.acwrChart)}</p>
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

      <h2 class="subheader">Charge Foster — répartition par sport</h2>
      <div class="card">
        <div class="chart-wrap"><canvas id="chart-sport-foster"></canvas></div>
        <p class="caption" id="sport-foster-caption"></p>
      </div>

      <h2 class="subheader">CAP — Km, D+ et heures hebdomadaires</h2>
      <div class="card">
        <div class="chart-wrap"><canvas id="chart-cap"></canvas></div>
        <p class="alert alert-info" id="cap-empty" style="display:none;">Aucune activité CAP sur la période sélectionnée.</p>
      </div>

      <h2 class="subheader">Vélo — Km, D+, heures et kJ hebdomadaires</h2>
      <div class="card">
        <div class="chart-wrap"><canvas id="chart-bike"></canvas></div>
        <p class="alert alert-info" id="bike-empty" style="display:none;">Aucune activité vélo sur la période sélectionnée.</p>
      </div>

      <details class="expander">
        <summary>Détail des séances</summary>
        ${renderSessionsTable(data)}
      </details>

      <hr class="sep" />
      <p class="caption">Foster = icu_rpe × moving_time (minutes).</p>
    `;

    renderSportFosterChart(data);
    renderCapChart(data);
    renderBikeChart(data);
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
