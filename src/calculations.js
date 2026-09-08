'use strict';

const { dateOnly, addDaysIso, weekStartMonday, dateRangeIso, todayIso, compareIso } = require('./dateUtils');
const sessionLoad = require('./sessionLoad.json');

const NUM = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const NUM_OR_NULL = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ============================================================
// PREPARATION DES DONNEES (port de api_events_to_dataframe + prepare)
// ============================================================

/**
 * Convertit les événements bruts Intervals.icu (/activities) en activités
 * "préparées" : date normalisée, foster_load, etc. Filtre pour ne garder
 * que les activités réalisées (moving_time > 0, hors catégories
 * NOTE/WORKOUT/PLAN), comme le dashboard Streamlit d'origine.
 */
function prepareActivities(rawEvents) {
  if (!rawEvents || !rawEvents.length) return [];

  let rows = rawEvents.map((e) => ({ ...e }));

  const filtered = rows.filter((e) => {
    const category = String(e.category || '').toUpperCase();
    const moving = NUM(e.moving_time, 0);
    return moving > 0 && !['NOTE', 'WORKOUT', 'PLAN'].includes(category);
  });

  if (filtered.length) rows = filtered;

  const activities = rows.map((e) => {
    const moving_time = NUM(e.moving_time, 0);
    const icu_rpe = NUM_OR_NULL(e.icu_rpe);
    const foster_load = (icu_rpe || 0) * moving_time / 60.0;

    return {
      ...e,
      date: dateOnly(e.start_date_local || e.start_date),
      moving_time,
      icu_rpe,
      foster_load,
      type: e.type || 'Autre',
      name: e.name || '',
      distance: NUM(e.distance, 0),
      total_elevation_gain: NUM(e.total_elevation_gain, 0),
      icu_average_watts: NUM_OR_NULL(e.icu_average_watts),
      icu_normalized_watts: NUM_OR_NULL(e.icu_normalized_watts),
      average_heartrate: NUM_OR_NULL(e.average_heartrate),
      max_heartrate: NUM_OR_NULL(e.max_heartrate),
    };
  });

  activities.sort((a, b) => compareIso(a.date || '', b.date || ''));
  return activities;
}

// ============================================================
// CHARGE JOURNALIERE
// ============================================================

/** Charge Foster quotidienne (jours sans séance inclus à 0) + rolling 7 jours. */
function dailyLoad(activities) {
  if (!activities.length) return [];

  const byDate = new Map();
  for (const a of activities) {
    if (!a.date) continue;
    byDate.set(a.date, (byDate.get(a.date) || 0) + a.foster_load);
  }
  if (!byDate.size) return [];

  const dates = [...byDate.keys()].sort(compareIso);
  const full = dateRangeIso(dates[0], dates[dates.length - 1]);

  const daily = full.map((date) => ({ date, foster_load: byDate.get(date) || 0 }));

  // Rolling 7 jours (fenêtre glissante, min_periods=1)
  for (let i = 0; i < daily.length; i++) {
    const start = Math.max(0, i - 6);
    let sum = 0;
    for (let j = start; j <= i; j++) sum += daily[j].foster_load;
    daily[i].load_7d = sum;
  }

  return daily;
}

/** Charge Foster quotidienne, ventilée par sport. */
function dailyLoadBySport(activities) {
  const byKey = new Map();
  for (const a of activities) {
    if (!a.date) continue;
    const sport = a.type || 'Autre';
    const key = `${a.date}\u0000${sport}`;
    byKey.set(key, (byKey.get(key) || 0) + a.foster_load);
  }
  return [...byKey.entries()].map(([key, foster_load]) => {
    const [date, sport] = key.split('\u0000');
    return { date, sport, foster_load };
  });
}

// ============================================================
// ACWR
// ============================================================

/** Regroupe une série "daily" {date, foster_load} en charge hebdomadaire + chronique + ACWR. */
function weeklyMetricsFromDaily(daily) {
  if (!daily.length) return [];

  const byWeek = new Map();
  for (const d of daily) {
    const week = weekStartMonday(d.date);
    byWeek.set(week, (byWeek.get(week) || 0) + d.foster_load);
  }

  const weeks = [...byWeek.keys()].sort(compareIso);
  const weekly = weeks.map((week) => ({ week, weekly_load: byWeek.get(week) }));

  // chronic_load_4w : moyenne des 4 semaines précédentes (semaine courante exclue).
  // En dessous de 4 semaines d'historique disponibles, on ne calcule pas d'ACWR (trop peu fiable).
  for (let i = 0; i < weekly.length; i++) {
    const windowStart = Math.max(0, i - 4);
    const windowVals = weekly.slice(windowStart, i).map((w) => w.weekly_load); // jusqu'à 4 semaines avant i
    weekly[i].chronic_load_4w = windowVals.length >= 4 ? windowVals.reduce((s, v) => s + v, 0) / windowVals.length : null;
    weekly[i].acute_load_7d = weekly[i].weekly_load;
    weekly[i].acwr =
      weekly[i].chronic_load_4w && weekly[i].chronic_load_4w > 0
        ? weekly[i].acute_load_7d / weekly[i].chronic_load_4w
        : null;
  }

  return weekly;
}

function calculateLoadMetrics(activities) {
  const daily = dailyLoad(activities);
  return weeklyMetricsFromDaily(daily);
}

// ============================================================
// PLANIFICATION HELP
// ============================================================

const PLANNING_PHASE_TARGETS = {
  Charge: { acwr_min: 1.0, acwr_target: 1.15, acwr_max: 1.3 },
  Récupération: { acwr_min: 0.6, acwr_target: 0.7, acwr_max: 0.8 },
};

function calculatePlanningTargets(activities) {
  const metrics = calculateLoadMetrics(activities);
  const currentWeek = weekStartMonday(todayIso());
  const completed = metrics.filter((m) => compareIso(m.week, currentWeek) < 0);
  const source = completed.length ? completed : metrics;
  const valid = source.filter((m) => m.chronic_load_4w != null && m.chronic_load_4w > 0);
  if (!valid.length) return null;

  const latest = valid.at(-1);
  const chronic = latest.chronic_load_4w;
  const currentWeekMetrics = metrics.find((m) => m.week === currentWeek);

  const targets = {};
  for (const [phase, v] of Object.entries(PLANNING_PHASE_TARGETS)) {
    targets[phase] = {
      acwr_min: v.acwr_min,
      acwr_target: v.acwr_target,
      acwr_max: v.acwr_max,
      load_min: chronic * v.acwr_min,
      load_target: chronic * v.acwr_target,
      load_max: chronic * v.acwr_max,
      daily_min: (chronic * v.acwr_min) / 7,
      daily_target: (chronic * v.acwr_target) / 7,
      daily_max: (chronic * v.acwr_max) / 7,
    };
  }

  return {
    week: latest.week,
    chronic,
    acwr: latest.acwr,
    weeklyHistory: source.slice(-16).map((m) => ({
      week: m.week,
      weekly_load: m.weekly_load,
      chronic_load_4w: m.chronic_load_4w,
      acwr: m.acwr,
    })),
    // Charge réelle déjà enregistrée sur la semaine en cours (partielle, jours écoulés uniquement).
    currentWeekActual: currentWeekMetrics ? { week: currentWeekMetrics.week, weekly_load: currentWeekMetrics.weekly_load } : null,
    targets,
  };
}

// ============================================================
// FORECAST (séances planifiées)
// ============================================================

const FORECAST_RUN_TYPES = new Set(['run', 'trail', 'trailrun', 'trail_run', 'virtualrun']);
const FORECAST_BIKE_TYPES = new Set(['ride', 'virtualride', 'mountainbikeride', 'gravelride', 'ebikeride']);
const FORECAST_WEIGH_TYPES = new Set(['weighttraining']);

function normalizeSportKey(s) {
  return String(s || '').toLowerCase().replace(/ /g, '').replace(/_/g, '');
}

/** Estime le RPE d'une séance planifiée selon le sport et le nom (voir src/sessionLoad.json). */
function rpeForPlanned(sport, name) {
  const s = normalizeSportKey(sport);
  const n = String(name || '').toLowerCase();
  const cfg = sessionLoad.forecastRpe;

  if (FORECAST_RUN_TYPES.has(s)) {
    const match = cfg.run.keywordRpe.find((entry) => entry.keywords.some((k) => n.includes(k)));
    return match ? match.rpe : cfg.run.default;
  }
  if (FORECAST_BIKE_TYPES.has(s)) return cfg.bike.default;
  if (FORECAST_WEIGH_TYPES.has(s)) return cfg.weightTraining.default;
  return cfg.other.default;
}

/** RPE effectif d'une séance planifiée : privilégie icu_rpe si déjà renseigné sur l'événement
 * (ex: séance envoyée par ce dashboard), sinon retombe sur l'estimation heuristique par mots-clés. */
function effectiveRpeForPlanned(sport, name, icuRpe) {
  const explicit = NUM_OR_NULL(icuRpe);
  return explicit && explicit > 0 ? explicit : rpeForPlanned(sport, name);
}

/**
 * Étend le calcul ACWR avec les séances planifiées (passées et futures).
 * futureDaily : [{date, foster_load}] issu des événements WORKOUT/PLAN/RACE.
 */
function calculateForecastAcwr(pastActivities, futureDaily) {
  if (!pastActivities.length || !futureDaily.length) return [];

  const daily = dailyLoad(pastActivities).map((d) => ({ date: d.date, foster_load: d.foster_load }));
  if (!daily.length) return [];

  const today = todayIso();
  const currentWeekStart = weekStartMonday(today);

  const planByDate = new Map(futureDaily.map((d) => [d.date, d.foster_load]));
  const pastByDate = new Map(daily.map((d) => [d.date, d.foster_load]));

  const allDates = [...pastByDate.keys(), ...planByDate.keys()];
  const minDate = allDates.reduce((a, b) => (compareIso(a, b) < 0 ? a : b));
  const maxDate = allDates.reduce((a, b) => (compareIso(a, b) > 0 ? a : b));

  const combined = dateRangeIso(minDate, maxDate).map((date) => {
    const planLoad = planByDate.has(date) ? planByDate.get(date) : null;
    const pastLoad = pastByDate.get(date) || 0;
    const isCurrentWeek = weekStartMonday(date) === currentWeekStart;

    // Semaine en cours (terminée ou non) : l'ACWR prévisionnel doit rester une projection pure du
    // plan, sans se mélanger au réel déjà fait — sinon il ne dit plus rien du plan lui-même.
    // Semaine strictement passée sans activité réelle : jour de repos (0), on ne ressuscite pas une
    // vieille séance planifiée jamais réalisée (ça gonflerait la charge chronique historique).
    let fosterLoad;
    if (isCurrentWeek || compareIso(date, today) > 0) {
      fosterLoad = planLoad || 0;
    } else if (pastLoad > 0) {
      fosterLoad = pastLoad;
    } else {
      fosterLoad = 0;
    }

    return { date, foster_load: fosterLoad, plan_load: planLoad };
  });

  const weeklyAll = weeklyMetricsFromDaily(combined);

  for (const w of weeklyAll) {
    w.is_forecast = compareIso(w.week, currentWeekStart) >= 0;
  }

  return weeklyAll;
}

module.exports = {
  prepareActivities,
  dailyLoad,
  dailyLoadBySport,
  calculateLoadMetrics,
  calculatePlanningTargets,
  rpeForPlanned,
  effectiveRpeForPlanned,
  calculateForecastAcwr,
  FORECAST_RUN_TYPES,
  FORECAST_BIKE_TYPES,
  normalizeSportKey,
};
