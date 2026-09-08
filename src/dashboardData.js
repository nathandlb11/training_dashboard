'use strict';

const { fetchIntervalsEvents, fetchCalendarEvents } = require('./intervalsApi');
const {
  prepareActivities,
  dailyLoad,
  dailyLoadBySport,
  calculateLoadMetrics,
  calculateForecastAcwr,
  effectiveRpeForPlanned,
  FORECAST_RUN_TYPES,
  FORECAST_BIKE_TYPES,
  normalizeSportKey,
} = require('./calculations');
const { dateOnly, addDaysIso, weekStartMonday, dateRangeIso, todayIso, compareIso } = require('./dateUtils');
const { fmtTime } = require('./format');
const sessionLoad = require('./sessionLoad.json');

const NUM = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const RUN_TRAIL = FORECAST_RUN_TYPES;
const BIKE_TYPES = FORECAST_BIKE_TYPES;
const DPLUS_SCALE = 100;

function groupSum(rows, keyFn, valFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    map.set(k, (map.get(k) || 0) + valFn(r));
  }
  return map;
}

/** Construit les données prévisionnelles (séances planifiées) à partir des événements calendrier. */
function buildForecast(rawFutureEvents) {
  const empty = {
    forecastDaily: [],
    totalPlannedDaily: [],
    raceEvents: [],
    planRunWeekly: new Map(),
    planBikeWeekly: new Map(),
    debugRaw: [],
  };
  if (!rawFutureEvents || !rawFutureEvents.length) return empty;

  const rows = rawFutureEvents.map((e) => ({
    ...e,
    date: dateOnly(e.start_date_local || e.start_date),
    moving_time: NUM(e.moving_time, 0),
    category: String(e.category || '').toUpperCase(),
  }));

  const debugRaw = rows.map((r) => ({
    start_date_local: r.start_date_local || r.start_date || '',
    name: r.name || '',
    category: r.category || '',
    type: r.type || '',
    moving_time: r.moving_time,
  }));

  // Toutes les séances planifiées (réalisées ou non) : sert à calculer la charge planifiée
  // totale d'une semaine, indépendamment de ce qui reste à faire.
  const allWorkouts = rows.filter((r) => r.date && ['WORKOUT', 'PLAN'].includes(r.category));
  const totalPlannedByDate = new Map();
  for (const w of allWorkouts) {
    const rpe = effectiveRpeForPlanned(w.type, w.name, w.icu_rpe);
    const load = (rpe * w.moving_time) / 60.0;
    totalPlannedByDate.set(w.date, (totalPlannedByDate.get(w.date) || 0) + load);
  }

  // Exclure les séances déjà liées à une activité réelle (activity_id présent = réalisée)
  const workouts = rows.filter((r) => r.date && ['WORKOUT', 'PLAN'].includes(r.category) && !r.activity_id);
  let forecastByDate = new Map();
  const planRunWeekly = new Map();
  const planBikeWeekly = new Map();

  if (workouts.length) {
    for (const w of workouts) {
      const rpe = effectiveRpeForPlanned(w.type, w.name, w.icu_rpe);
      w.foster_load = (rpe * w.moving_time) / 60.0;
      w.week = weekStartMonday(w.date);
      w.sport_key = normalizeSportKey(w.type);
    }

    forecastByDate = groupSum(workouts, (w) => w.date, (w) => w.foster_load);

    const runRows = workouts.filter((w) => RUN_TRAIL.has(w.sport_key));
    const runByWeek = groupSum(runRows, (w) => w.week, (w) => w.moving_time);
    for (const [week, secs] of runByWeek) planRunWeekly.set(week, secs / 3600);

    const bikeRows = workouts.filter((w) => BIKE_TYPES.has(w.sport_key));
    const bikeByWeek = groupSum(bikeRows, (w) => w.week, (w) => w.moving_time);
    for (const [week, secs] of bikeByWeek) planBikeWeekly.set(week, secs / 3600);
  }

  const raceEvents = [];
  const planRaceWeekly = new Map(); // semaine -> [noms de courses]
  const races = rows.filter((r) => r.date && ['RACE_A', 'RACE_B', 'RACE_C'].includes(r.category));
  if (races.length) {
    const seenDates = new Set();
    for (const r of races) {
      r.foster_load = (sessionLoad.race.rpe * r.moving_time) / 60.0;
      r.week = weekStartMonday(r.date);
      r.sport_key = normalizeSportKey(r.type);
      if (!seenDates.has(r.date)) {
        seenDates.add(r.date);
        raceEvents.push({ date: r.date, name: r.name || '' });
      }
      // Accumuler le nom de la course par semaine pour le tooltip
      const names = planRaceWeekly.get(r.week) || [];
      if (!names.includes(r.name || '')) names.push(r.name || '');
      planRaceWeekly.set(r.week, names);
    }
    const raceByDate = groupSum(races, (r) => r.date, (r) => r.foster_load);
    for (const [date, load] of raceByDate) {
      forecastByDate.set(date, (forecastByDate.get(date) || 0) + load);
      totalPlannedByDate.set(date, (totalPlannedByDate.get(date) || 0) + load);
    }
    // Ajouter les heures de course aux totaux planifiés par sport
    const raceRunRows = races.filter((r) => RUN_TRAIL.has(r.sport_key));
    const raceRunByWeek = groupSum(raceRunRows, (r) => r.week, (r) => r.moving_time);
    for (const [week, secs] of raceRunByWeek) planRunWeekly.set(week, (planRunWeekly.get(week) || 0) + secs / 3600);

    const raceBikeRows = races.filter((r) => BIKE_TYPES.has(r.sport_key));
    const raceBikeByWeek = groupSum(raceBikeRows, (r) => r.week, (r) => r.moving_time);
    for (const [week, secs] of raceBikeByWeek) planBikeWeekly.set(week, (planBikeWeekly.get(week) || 0) + secs / 3600);
  }

  const forecastDaily = [...forecastByDate.entries()]
    .map(([date, foster_load]) => ({ date, foster_load }))
    .sort((a, b) => compareIso(a.date, b.date));

  const totalPlannedDaily = [...totalPlannedByDate.entries()]
    .map(([date, foster_load]) => ({ date, foster_load }))
    .sort((a, b) => compareIso(a.date, b.date));

  const notes = rows
    .filter((r) => r.date && r.category === 'NOTE')
    .map((r) => ({ date: r.date, name: r.name || '' }))
    .sort((a, b) => compareIso(a.date, b.date));

  return { forecastDaily, totalPlannedDaily, raceEvents, planRunWeekly, planBikeWeekly, planRaceWeekly, notes, debugRaw };
}

/** Foster 7 jours "planifié" : prolonge la courbe réelle avec la charge future planifiée. */
function buildPlanRoll(activities, forecastDaily) {
  const today = todayIso();
  const planFuture = forecastDaily.filter((d) => compareIso(d.date, today) > 0);
  if (!planFuture.length) return [];

  const pastDaily = dailyLoad(activities);
  if (!pastDaily.length) return [];

  const pastByDate = new Map(pastDaily.map((d) => [d.date, d.foster_load]));
  const planByDate = new Map(planFuture.map((d) => [d.date, d.foster_load]));

  const allDatesSrc = [...pastByDate.keys(), ...planByDate.keys()];
  const minDate = allDatesSrc.reduce((a, b) => (compareIso(a, b) < 0 ? a : b));
  const maxDate = allDatesSrc.reduce((a, b) => (compareIso(a, b) > 0 ? a : b));

  const combined = dateRangeIso(minDate, maxDate).map((date) => {
    const isFuture = compareIso(date, today) > 0;
    const foster_load = isFuture ? planByDate.get(date) || 0 : pastByDate.get(date) || 0;
    return { date, foster_load };
  });

  for (let i = 0; i < combined.length; i++) {
    const start = Math.max(0, i - 6);
    let sum = 0;
    for (let j = start; j <= i; j++) sum += combined[j].foster_load;
    combined[i].load_7d = sum;
  }

  return combined.filter((d) => compareIso(d.date, today) > 0).map((d) => ({ date: d.date, load_7d: d.load_7d }));
}

function weeklySportAgg(rows, periodStart, periodEnd) {
  const inPeriod = rows.filter((r) => r.date && compareIso(r.date, periodStart) >= 0 && compareIso(r.date, periodEnd) <= 0);
  const byWeek = new Map();
  for (const r of inPeriod) {
    const week = weekStartMonday(r.date);
    if (!byWeek.has(week)) byWeek.set(week, { week, km: 0, dplus: 0, heuresSecs: 0, kj: 0 });
    const acc = byWeek.get(week);
    acc.km += NUM(r.distance, 0) / 1000;
    acc.dplus += NUM(r.total_elevation_gain, 0);
    acc.heuresSecs += NUM(r.moving_time, 0);
    acc.kj += r.kj || 0;
  }
  return [...byWeek.values()]
    .sort((a, b) => compareIso(a.week, b.week))
    .map((w) => ({ week: w.week, km: w.km, dplus: w.dplus, heures: w.heuresSecs / 3600, kj: w.kj }));
}

async function buildDashboardData({
  apiKey,
  athleteId = '0',
  historyStart,
  historyEnd,
  periodStart,
  periodEnd,
  types,
  forecastWeeks = 8,
}) {
  const rawEvents = await fetchIntervalsEvents(apiKey, historyStart, historyEnd, athleteId);
  const df = prepareActivities(rawEvents);

  if (!df.length) {
    return { empty: true, message: 'Aucune activité réalisée trouvée sur la période sélectionnée.' };
  }

  const allTypes = [...new Set(df.map((a) => a.type).filter(Boolean))].sort();
  const dfDates = df.map((a) => a.date).filter(Boolean).sort(compareIso);
  const minDate = dfDates[0];
  const maxDate = dfDates[dfDates.length - 1];

  const pStart = periodStart || minDate;
  const pEnd = periodEnd || maxDate;
  const selectedTypes = types && types.length ? types : allTypes;

  const f = df.filter(
    (a) => a.date && compareIso(a.date, pStart) >= 0 && compareIso(a.date, pEnd) <= 0 && selectedTypes.includes(a.type)
  );

  const kpis = {
    totalLoad: f.reduce((s, a) => s + a.foster_load, 0),
    totalTime: f.reduce((s, a) => s + a.moving_time, 0),
    totalTimeFmt: fmtTime(f.reduce((s, a) => s + a.moving_time, 0)),
    totalDplus: f.reduce((s, a) => s + NUM(a.total_elevation_gain, 0), 0),
    sessions: f.length,
  };

  // ------------------------------------------------------------
  // Prévisionnel (séances planifiées + courses)
  // ------------------------------------------------------------
  let forecast = { forecastDaily: [], totalPlannedDaily: [], raceEvents: [], planRunWeekly: new Map(), planBikeWeekly: new Map(), planRaceWeekly: new Map(), notes: [], debugRaw: [] };
  let forecastError = null;
  try {
    const forecastEnd = addDaysIso(todayIso(), forecastWeeks * 7);
    const futureRaw = await fetchCalendarEvents(apiKey, historyStart, forecastEnd, athleteId);
    forecast = buildForecast(futureRaw);
  } catch (e) {
    forecastError = e.message;
  }

  // Bornées à pEnd : une semaine affichée ne doit jamais inclure des jours au-delà
  // de la période visible ailleurs (sessions, graphiques), sinon l'ACWR "fuit" des
  // activités invisibles dans le reste du dashboard.
  const dfUntilPeriodEnd = df.filter((a) => a.date && compareIso(a.date, pEnd) <= 0);

  // Charge totale planifiée (pas seulement le "reste à faire") : la semaine en cours doit refléter
  // le plan complet dans l'ACWR prévisionnel, y compris les séances planifiées déjà réalisées.
  const forecastWeekly = calculateForecastAcwr(dfUntilPeriodEnd, forecast.totalPlannedDaily);
  const planRoll = buildPlanRoll(dfUntilPeriodEnd, forecast.forecastDaily);

  // ------------------------------------------------------------
  // Charge Foster par sport (empilé) + Foster 7j
  // ------------------------------------------------------------
  const sportDailyRaw = dailyLoadBySport(df).map((r) => ({
    ...r,
    sport: RUN_TRAIL.has(normalizeSportKey(r.sport)) ? 'Run / Trail' : r.sport,
  }));
  const sportDailyMap = groupSum(sportDailyRaw, (r) => `${r.date}\u0000${r.sport}`, (r) => r.foster_load);
  const sportDailyMerged = [...sportDailyMap.entries()].map(([k, v]) => {
    const [date, sport] = k.split('\u0000');
    return { date, sport, foster_load: v };
  });

  const sportDisplay = sportDailyMerged.filter(
    (r) => r.date && compareIso(r.date, pStart) >= 0 && compareIso(r.date, pEnd) <= 0
  );
  const sportsSet = [...new Set(sportDisplay.map((r) => r.sport))].sort();
  const sportDates = [...new Set(sportDisplay.map((r) => r.date))].sort(compareIso);
  const sportPivotMap = new Map();
  for (const r of sportDisplay) sportPivotMap.set(`${r.date}\u0000${r.sport}`, r.foster_load);

  const sportFosterChart = {
    dates: sportDates,
    sports: sportsSet.map((sport) => ({
      name: sport,
      values: sportDates.map((d) => sportPivotMap.get(`${d}\u0000${sport}`) || 0),
    })),
    roll7: (() => {
      const roll = dailyLoad(df).filter((d) => compareIso(d.date, pStart) >= 0 && compareIso(d.date, pEnd) <= 0);
      return { dates: roll.map((d) => d.date), values: roll.map((d) => d.load_7d), last: roll.length ? roll[roll.length - 1] : null };
    })(),
    planRoll7: { dates: planRoll.map((d) => d.date), values: planRoll.map((d) => d.load_7d) },
  };

  // ------------------------------------------------------------
  // CAP — km / D+ / heures hebdomadaires
  // ------------------------------------------------------------
  const runRows = df.filter((a) => RUN_TRAIL.has(normalizeSportKey(a.type)));
  const runWeekly = weeklySportAgg(runRows, pStart, pEnd);
  const capChart = {
    weeks: runWeekly.map((w) => w.week),
    km: runWeekly.map((w) => w.km),
    dplus: runWeekly.map((w) => w.dplus),
    dplusScaled: runWeekly.map((w) => w.dplus / DPLUS_SCALE),
    heures: runWeekly.map((w) => w.heures),
    plannedWeeks: [...forecast.planRunWeekly.keys()].sort(compareIso),
    plannedHeures: [...forecast.planRunWeekly.keys()].sort(compareIso).map((w) => forecast.planRunWeekly.get(w)),
    plannedRaces: [...forecast.planRunWeekly.keys()].sort(compareIso).map((w) => (forecast.planRaceWeekly.get(w) || []).join(', ')),
    dplusScale: DPLUS_SCALE,
  };

  // ------------------------------------------------------------
  // Vélo — km / D+ / heures / kJ hebdomadaires
  // ------------------------------------------------------------
  const bikeRowsRaw = df.filter((a) => BIKE_TYPES.has(normalizeSportKey(a.type)));
  const bikeRows = bikeRowsRaw.map((a) => {
    const kjCol = a.kilojoules ?? a.total_work ?? a.work_kj;
    let kj;
    if (kjCol != null) kj = NUM(kjCol, 0);
    else if (a.icu_average_watts != null || a.average_watts != null)
      kj = (NUM(a.icu_average_watts ?? a.average_watts, 0) * NUM(a.moving_time, 0)) / 1000;
    else kj = 0;
    return { ...a, kj };
  });
  let bikeWeekly = weeklySportAgg(bikeRows, pStart, pEnd);
  if (runWeekly.length) {
    const bikeByWeek = new Map(bikeWeekly.map((w) => [w.week, w]));
    bikeWeekly = runWeekly
      .map((r) => r.week)
      .concat([...bikeByWeek.keys()].filter((w) => !runWeekly.some((r) => r.week === w)))
      .filter((w, i, arr) => arr.indexOf(w) === i)
      .sort(compareIso)
      .map((week) => bikeByWeek.get(week) || { week, km: 0, dplus: 0, heures: 0, kj: 0 });
  }
  const bikeChart = {
    weeks: bikeWeekly.map((w) => w.week),
    km: bikeWeekly.map((w) => w.km),
    dplus: bikeWeekly.map((w) => w.dplus),
    dplusScaled: bikeWeekly.map((w) => w.dplus / DPLUS_SCALE),
    heures: bikeWeekly.map((w) => w.heures),
    kj: bikeWeekly.map((w) => w.kj),
    plannedWeeks: [...forecast.planBikeWeekly.keys()].sort(compareIso),
    plannedHeures: [...forecast.planBikeWeekly.keys()].sort(compareIso).map((w) => forecast.planBikeWeekly.get(w)),
    plannedRaces: [...forecast.planBikeWeekly.keys()].sort(compareIso).map((w) => (forecast.planRaceWeekly.get(w) || []).join(', ')),
    dplusScale: DPLUS_SCALE,
  };

  // ------------------------------------------------------------
  // ACWR
  // ------------------------------------------------------------
  const loadMetrics = calculateLoadMetrics(dfUntilPeriodEnd);
  const metricsDisplay = loadMetrics.filter((m) => compareIso(m.week, pStart) >= 0 && compareIso(m.week, pEnd) <= 0);

  const forecastOnly = forecastWeekly.filter((w) => w.is_forecast);

  const acwrByWeek = new Map(forecastWeekly.map((w) => [w.week, w.acwr]));
  const raceMarkers = forecast.raceEvents
    .map((r) => ({ week: weekStartMonday(r.date), name: r.name }))
    .filter((r) => acwrByWeek.has(r.week) && acwrByWeek.get(r.week) != null)
    .map((r) => ({ week: r.week, name: r.name, acwr: acwrByWeek.get(r.week) }));

  // Barres de charge hebdo : réelle pour les semaines déjà vécues, planifiée pour les jours pas
  // encore vécus. Sur la semaine en cours les deux coexistent (déjà réalisé + reste planifié),
  // empilées pour visualiser la charge totale prévue de la semaine.
  const today = todayIso();
  const realWeeklyMap = new Map(loadMetrics.map((m) => [m.week, m.weekly_load]));
  // Charge chronique "actuelle" indépendante de la période affichée : pEnd (donc metricsDisplay)
  // s'arrête à la dernière activité réelle, qui peut être ancienne si l'athlète (souvent un
  // coaché) n'a pas loggé récemment. On réutilise le chronic_load_4w déjà calculé pour la semaine
  // en cours dans forecastWeekly (même source que l'ACWR prévisionnel affiché), pour rester
  // cohérent avec celui-ci ; à défaut (aucune séance planifiée), on retombe sur le réel jusqu'à
  // aujourd'hui, comme dans l'onglet planification.
  const currentWeekEntry = forecastWeekly.find((w) => w.week === weekStartMonday(today));
  let currentChronicLoad = currentWeekEntry && currentWeekEntry.chronic_load_4w > 0 ? currentWeekEntry.chronic_load_4w : null;
  if (currentChronicLoad == null) {
    const loadMetricsToToday = calculateLoadMetrics(df.filter((a) => a.date && compareIso(a.date, today) <= 0));
    const validChronicToToday = loadMetricsToToday.filter((m) => m.chronic_load_4w != null && m.chronic_load_4w > 0);
    currentChronicLoad = validChronicToToday.length ? validChronicToToday.at(-1).chronic_load_4w : null;
  }
  // Les séances déjà réalisées (activity_id lié) sont déjà exclues de forecastDaily par
  // buildForecast : on peut donc inclure aujourd'hui sans risquer un double comptage.
  const futureDaily = forecast.forecastDaily.filter((d) => compareIso(d.date, today) >= 0);
  const plannedWeeklyMap = groupSum(futureDaily, (d) => weekStartMonday(d.date), (d) => d.foster_load);
  // Charge planifiée totale de la semaine (réalisée ou non), pour comparer en direct le
  // "reste à faire" à ce qui était prévu au départ.
  const plannedTotalWeeklyMap = groupSum(forecast.totalPlannedDaily, (d) => weekStartMonday(d.date), (d) => d.foster_load);
  const loadBarWeeks = [...new Set([...realWeeklyMap.keys(), ...plannedWeeklyMap.keys()])].sort(compareIso);

  const acwrChart = {
    weeks: metricsDisplay.map((m) => m.week),
    acwr: metricsDisplay.map((m) => m.acwr),
    chronicLoad4w: metricsDisplay.map((m) => m.chronic_load_4w),
    currentChronicLoad,
    weeklyLoad: {
      weeks: loadBarWeeks,
      real: loadBarWeeks.map((w) => realWeeklyMap.get(w) || 0),
      planned: loadBarWeeks.map((w) => plannedWeeklyMap.get(w) || 0),
      plannedTotal: loadBarWeeks.map((w) => plannedTotalWeeklyMap.get(w) || 0),
      currentWeek: weekStartMonday(today),
    },
    forecast: {
      weeks: forecastOnly.map((w) => w.week),
      acwr: forecastOnly.map((w) => w.acwr),
      chronicLoad4w: forecastOnly.map((w) => w.chronic_load_4w),
    },
    raceMarkers,
  };

  // ------------------------------------------------------------
  // Détail des séances
  // ------------------------------------------------------------
  const sessionsTable = f.map((a) => ({
    date: a.date,
    name: a.name,
    type: a.type,
    temps: fmtTime(a.moving_time),
    rpe: a.icu_rpe,
    chargeFoster: Math.round(a.foster_load),
    dplus: Math.round(NUM(a.total_elevation_gain, 0)),
    distanceKm: Math.round((NUM(a.distance, 0) / 1000) * 10) / 10,
  }));

  return {
    empty: false,
    meta: { minDate, maxDate, allTypes, selectedTypes, periodStart: pStart, periodEnd: pEnd },
    kpis,
    sportFosterChart,
    capChart,
    bikeChart,
    acwrChart,
    sessionsTable,
    notes: forecast.notes,
    forecastError,
    debugRaw: forecast.debugRaw,
  };
}

module.exports = { buildDashboardData };
