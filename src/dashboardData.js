'use strict';

const { fetchIntervalsEvents, fetchCalendarEvents, fetchWellness, fetchAthleteProfile } = require('./intervalsApi');
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
  normalizeZoneTimes,
} = require('./calculations');
const { dateOnly, addDaysIso, weekStartMonday, dateRangeIso, todayIso, compareIso } = require('./dateUtils');
const { fmtTime, parseDescriptionSteps } = require('./format');
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
    w.week = weekStartMonday(w.date);
    w.sport_key = normalizeSportKey(w.type);
  }

  // Volume horaire planifié par sport/semaine : total de la semaine (réalisé ou non), pas seulement
  // ce qui reste à faire, sinon une semaine en cours partiellement réalisée s'affiche sous-comptée.
  const planRunWeekly = new Map();
  const planBikeWeekly = new Map();
  const runRows = allWorkouts.filter((w) => RUN_TRAIL.has(w.sport_key));
  const runByWeek = groupSum(runRows, (w) => w.week, (w) => w.moving_time);
  for (const [week, secs] of runByWeek) planRunWeekly.set(week, secs / 3600);

  const bikeRows = allWorkouts.filter((w) => BIKE_TYPES.has(w.sport_key));
  const bikeByWeek = groupSum(bikeRows, (w) => w.week, (w) => w.moving_time);
  for (const [week, secs] of bikeByWeek) planBikeWeekly.set(week, secs / 3600);

  // Exclure les séances déjà liées à une activité réelle (paired_activity_id présent = réalisée ;
  // Intervals.icu n'expose PAS de champ `activity_id` sur les événements calendrier) : sert au
  // forecast journalier "restant à faire" (forecastByDate), utilisé ailleurs.
  const workouts = rows.filter((r) => r.date && ['WORKOUT', 'PLAN'].includes(r.category) && !r.paired_activity_id);
  let forecastByDate = new Map();

  if (workouts.length) {
    for (const w of workouts) {
      w.foster_load = (effectiveRpeForPlanned(w.type, w.name, w.icu_rpe) * w.moving_time) / 60.0;
    }

    forecastByDate = groupSum(workouts, (w) => w.date, (w) => w.foster_load);
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

/**
 * Séances (planifiées et/ou réelles) de la semaine en cours (lundi -> dimanche), pour un widget
 * de suivi d'avancement. Une séance planifiée est "réalisée" si son événement calendrier porte un
 * `paired_activity_id` (lien Intervals.icu vers l'activité réelle) ; les activités réelles de la
 * semaine non liées à un événement planifié sont ajoutées à part (séances "hors plan").
 */
function buildCurrentWeekSessions(rawFutureEvents, df) {
  const today = todayIso();
  const weekStart = weekStartMonday(today);
  const weekEnd = addDaysIso(weekStart, 6);

  const weekRows = (rawFutureEvents || [])
    .map((e) => ({ ...e, date: dateOnly(e.start_date_local || e.start_date), category: String(e.category || '').toUpperCase() }))
    .filter((e) => e.date && compareIso(e.date, weekStart) >= 0 && compareIso(e.date, weekEnd) <= 0);

  const plannedRows = weekRows.filter((e) => ['WORKOUT', 'PLAN', 'RACE_A', 'RACE_B', 'RACE_C'].includes(e.category));

  const dfById = new Map(df.filter((a) => a.id != null).map((a) => [String(a.id), a]));
  const linkedActivityIds = new Set(
    plannedRows.filter((e) => e.paired_activity_id != null).map((e) => String(e.paired_activity_id))
  );

  const plannedSessions = plannedRows.map((e) => {
    const isRace = e.category.startsWith('RACE');
    const movingTime = NUM(e.moving_time, 0);
    const rpe = isRace ? sessionLoad.race.rpe : effectiveRpeForPlanned(e.type, e.name, e.icu_rpe);
    const plannedLoad = (rpe * movingTime) / 60;
    const real = e.paired_activity_id != null ? dfById.get(String(e.paired_activity_id)) : null;
    const done = !!real;

    let status;
    if (done) status = 'done';
    else if (compareIso(e.date, today) < 0) status = 'missed';
    else if (e.date === today) status = 'today';
    else status = 'upcoming';

    return {
      date: e.date,
      name: e.name || '',
      type: e.type || '',
      isRace,
      planned: true,
      done,
      status,
      plannedLoad: Math.round(plannedLoad),
      plannedTime: fmtTime(movingTime),
      realLoad: real ? Math.round(real.foster_load) : null,
      realTime: real ? fmtTime(real.moving_time) : null,
    };
  });

  const extraSessions = df
    .filter(
      (a) =>
        a.date &&
        compareIso(a.date, weekStart) >= 0 &&
        compareIso(a.date, weekEnd) <= 0 &&
        !(a.id != null && linkedActivityIds.has(String(a.id)))
    )
    .map((a) => ({
      date: a.date,
      name: a.name || '',
      type: a.type || '',
      isRace: false,
      planned: false,
      done: true,
      status: 'extra',
      plannedLoad: null,
      plannedTime: null,
      realLoad: Math.round(a.foster_load),
      realTime: fmtTime(a.moving_time),
    }));

  const sessions = [...plannedSessions, ...extraSessions].sort((a, b) => compareIso(a.date, b.date));

  const totals = {
    plannedLoad: Math.round(plannedSessions.reduce((s, x) => s + x.plannedLoad, 0)),
    realLoad: Math.round(sessions.reduce((s, x) => s + (x.realLoad || 0), 0)),
    plannedCount: plannedSessions.length,
    doneCount: sessions.filter((x) => x.done).length,
  };

  return { weekStart, weekEnd, today, sessions, totals };
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

function groupMean(rows, keyFn, valFn) {
  const sums = new Map();
  const counts = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const v = valFn(r);
    if (v == null || !Number.isFinite(v)) continue;
    sums.set(k, (sums.get(k) || 0) + v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = new Map();
  for (const [k, s] of sums) out.set(k, s / counts.get(k));
  return out;
}

function mean(arr) {
  const vals = (arr || []).filter((v) => v != null && Number.isFinite(v));
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/** Libellé de sport affiché (regroupe les variantes course/vélo, comme le graphique Foster par sport). */
function sportLabelFor(type) {
  const key = normalizeSportKey(type);
  if (RUN_TRAIL.has(key)) return 'Run / Trail';
  if (BIKE_TYPES.has(key)) return 'Ride';
  return type || 'Autre';
}

// ------------------------------------------------------------
// TRIMP hebdomadaire (2e mesure de charge, en complément du Foster/sRPE) + estimation planifiée
// ------------------------------------------------------------
function buildTrimpChart(realActivities, weeks, plannedTrimpByWeek) {
  const rows = realActivities.filter((a) => a.date && a.trimp != null);
  const byWeek = new Map();
  for (const r of rows) {
    const week = weekStartMonday(r.date);
    byWeek.set(week, (byWeek.get(week) || 0) + r.trimp);
  }
  return {
    weeks,
    trimp: weeks.map((w) => Math.round(byWeek.get(w) || 0)),
    plannedTrimp: weeks.map((w) => (plannedTrimpByWeek.has(w) ? Math.round(plannedTrimpByWeek.get(w)) : null)),
  };
}

function intensityBucket(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct < 75) return 'easy';
  if (pct < 90) return 'moderate';
  return 'hard';
}

/** Intensité moyenne (pondérée par la durée) des étapes d'une description planifiée, en % LTHR/FTP —
 * mélange volontairement les deux échelles (toutes deux des % d'un seuil propre au sport) pour
 * classer l'intensité en paliers simples (utilisé seulement pour choisir quelle moyenne historique
 * comparer, pas comme valeur physiologique exacte). `null` si la description n'a aucune étape avec
 * un pourcentage de zone (ex: renfo, description libre). */
function plannedIntensityPct(description) {
  const steps = parseDescriptionSteps(description).filter((s) => s.lowPct != null && s.highPct != null && s.durationMin > 0);
  if (!steps.length) return null;
  const totalMin = steps.reduce((s, st) => s + st.durationMin, 0);
  if (!(totalMin > 0)) return null;
  const weighted = steps.reduce((s, st) => s + ((st.lowPct + st.highPct) / 2) * st.durationMin, 0);
  return weighted / totalMin;
}

/** Moyenne de TRIMP/minute des séances réelles, par sport et par palier d'intensité (icu_intensity),
 * avec repli sur la moyenne du sport seul puis sur la moyenne globale. Sert de base à l'estimation
 * du TRIMP d'une séance planifiée (pas de FC prévisionnelle réelle disponible pour la calculer). */
function buildTrimpPerMinuteLookup(activities) {
  const bySportBucket = new Map();
  const bySport = new Map();
  let globalSum = 0;
  let globalCount = 0;
  for (const a of activities) {
    if (a.trimp == null || !(a.moving_time > 0)) continue;
    const perMin = a.trimp / (a.moving_time / 60);
    if (!Number.isFinite(perMin)) continue;
    const sport = sportLabelFor(a.type);
    const bucket = intensityBucket(NUM_OR_NULL(a.icu_intensity));
    if (bucket) {
      const key = `${sport}\u0000${bucket}`;
      const acc = bySportBucket.get(key) || { sum: 0, count: 0 };
      acc.sum += perMin;
      acc.count += 1;
      bySportBucket.set(key, acc);
    }
    const sAcc = bySport.get(sport) || { sum: 0, count: 0 };
    sAcc.sum += perMin;
    sAcc.count += 1;
    bySport.set(sport, sAcc);
    globalSum += perMin;
    globalCount += 1;
  }
  return (sport, bucket) => {
    if (bucket) {
      const acc = bySportBucket.get(`${sport}\u0000${bucket}`);
      if (acc && acc.count) return acc.sum / acc.count;
    }
    const sAcc = bySport.get(sport);
    if (sAcc && sAcc.count) return sAcc.sum / sAcc.count;
    return globalCount ? globalSum / globalCount : null;
  };
}

/** Estimation du TRIMP hebdomadaire des séances planifiées (aujourd'hui + futur, non déjà
 * réalisées) : à défaut de FC prévisionnelle réelle, on estime un "TRIMP/minute" à partir des
 * séances réelles similaires — même sport ET même palier d'intensité déduit des zones %LTHR/FTP de
 * la description quand elles existent, sinon juste le même sport (ex: renfo, sans zone dans sa
 * description libre). */
function buildPlannedTrimpByWeek(rawFutureEvents, realActivities, realActivityDates, today) {
  const lookup = buildTrimpPerMinuteLookup(realActivities);
  const rows = (rawFutureEvents || [])
    .map((e) => ({
      ...e,
      date: dateOnly(e.start_date_local || e.start_date),
      category: String(e.category || '').toUpperCase(),
      moving_time: NUM(e.moving_time, 0),
    }))
    .filter(
      (e) =>
        e.date &&
        ['WORKOUT', 'PLAN', 'RACE_A', 'RACE_B', 'RACE_C'].includes(e.category) &&
        compareIso(e.date, today) >= 0 &&
        !realActivityDates.has(e.date) &&
        e.moving_time > 0
    );

  const byWeek = new Map();
  for (const e of rows) {
    const sport = sportLabelFor(e.type);
    const bucket = intensityBucket(plannedIntensityPct(e.description));
    const perMin = lookup(sport, bucket);
    if (perMin == null) continue;
    const week = weekStartMonday(e.date);
    byWeek.set(week, (byWeek.get(week) || 0) + perMin * (e.moving_time / 60));
  }
  return byWeek;
}

// ------------------------------------------------------------
// Temps hebdomadaire dans les zones FC, ventilé par sport (filtrable côté client)
// Modèle simplifié à 3 paliers (regroupement des 7 zones Intervals.icu par numéro de zone) :
// Z1 seule, Z2+Z3, Z4/5/6/7 — plus lisible qu'un empilement à 7 zones.
// ------------------------------------------------------------
const HR_ZONE_GROUP_IDS = ['Z1', 'Z2-Z3', 'Z4-Z7'];

function hrZoneGroupIndex(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10);
  if (n === 1) return 0;
  if (n === 2 || n === 3) return 1;
  if (n >= 4) return 2;
  return null; // ids non numériques (ex: 'SS') hors modèle FC
}

function buildHrZoneChart(f, canonicalWeeks) {
  const zoneField = 'icu_hr_zone_times';
  const rows = f.filter((a) => a.date && Array.isArray(a[zoneField]) && a[zoneField].length);
  if (!rows.length) return { weeks: canonicalWeeks, zoneIds: [], zoneBounds: null, sports: [], rows: [] };

  const byKey = new Map(); // `${week}\u0000${sport}` -> minutes[3] (Z1 / Z2-Z3 / Z4-Z7)
  const sportsSeen = new Set();
  for (const a of rows) {
    const week = weekStartMonday(a.date);
    const sport = sportLabelFor(a.type);
    sportsSeen.add(sport);
    const key = `${week}\u0000${sport}`;
    const arr = byKey.get(key) || [0, 0, 0];
    for (const z of normalizeZoneTimes(a[zoneField])) {
      const gi = hrZoneGroupIndex(z.id);
      if (gi != null) arr[gi] += z.secs / 60;
    }
    byKey.set(key, arr);
  }

  // Bornes (bpm) des 3 paliers : haut de Z1, haut de Z3, haut de Z7 — depuis l'activité la plus
  // récente qui expose ses 7 zones FC.
  let zoneBounds = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = rows[i].icu_hr_zones;
    if (Array.isArray(b) && b.length >= 7) {
      zoneBounds = [b[0], b[2], b[6]];
      break;
    }
  }

  const outRows = [];
  for (const [key, minutes] of byKey) {
    const [week, sport] = key.split('\u0000');
    outRows.push({ week, sport, minutes: minutes.map((m) => Math.round(m)) });
  }

  return {
    weeks: canonicalWeeks,
    zoneIds: HR_ZONE_GROUP_IDS,
    zoneBounds,
    sports: [...sportsSeen].sort(),
    rows: outRows,
  };
}

// ------------------------------------------------------------
// Temps hebdomadaire dans les zones de puissance — Vélo uniquement (icu_zone_times, mesuré).
// Modèle simplifié à 3 paliers en %FTP : < 75%, 75-100%, > 100%.
// ------------------------------------------------------------
const POWER_ZONE_GROUP_IDS = ['< 75% FTP', '75-100% FTP', '> 100% FTP'];

/** Répartit les secondes d'une zone Coggan [lowPct, highPct[ (en %FTP) entre nos 3 paliers
 * <75/75-100/>100%, au prorata du recouvrement — approximation qui suppose le temps réparti
 * uniformément dans la zone d'origine (on n'a que le total par zone, pas la série watts brute). */
function splitSecsByFtpBucket(lowPct, highPct, secs) {
  const span = highPct - lowPct;
  if (!(span > 0) || !(secs > 0)) return [0, 0, 0];
  const ov1 = Math.max(0, Math.min(highPct, 75) - lowPct);
  const ov2 = Math.max(0, Math.min(highPct, 100) - Math.max(lowPct, 75));
  const ov3 = Math.max(0, highPct - Math.max(lowPct, 100));
  return [(secs * ov1) / span, (secs * ov2) / span, (secs * ov3) / span];
}

function buildPowerZoneChart(f, canonicalWeeks, profile) {
  const rideSettings =
    profile && Array.isArray(profile.sportSettings) ? profile.sportSettings.find((s) => Array.isArray(s.types) && s.types.includes('Ride')) : null;
  const ftp = rideSettings && rideSettings.ftp > 0 ? rideSettings.ftp : null;
  const pctBounds = rideSettings && Array.isArray(rideSettings.power_zones) ? rideSettings.power_zones : null;

  const zoneField = 'icu_zone_times';
  const rideRows = f.filter((a) => a.date && BIKE_TYPES.has(normalizeSportKey(a.type)) && Array.isArray(a[zoneField]) && a[zoneField].length);
  if (!rideRows.length) return { weeks: canonicalWeeks, zoneIds: [], wattBounds: null, sports: [], rows: [] };

  const byKey = new Map(); // `${week}\u0000${sport}` -> minutes[3] (<75% / 75-100% / >100% FTP)
  const sportsSeen = new Set();

  for (const a of rideRows) {
    const week = weekStartMonday(a.date);
    const sport = sportLabelFor(a.type);
    sportsSeen.add(sport);
    const key = `${week}\u0000${sport}`;
    const arr = byKey.get(key) || [0, 0, 0];
    normalizeZoneTimes(a[zoneField]).forEach((z, i) => {
      if (z.id === 'SS') return; // sweet-spot, hors modèle Coggan à 7 paliers, ignorée
      if (pctBounds && pctBounds[i] != null) {
        const lowPct = i === 0 ? 0 : pctBounds[i - 1];
        const [s1, s2, s3] = splitSecsByFtpBucket(lowPct, pctBounds[i], z.secs);
        arr[0] += s1 / 60;
        arr[1] += s2 / 60;
        arr[2] += s3 / 60;
      } else {
        // Pas de %FTP configuré côté athlète : repli grossier par numéro de zone Coggan.
        const gi = hrZoneGroupIndex(z.id);
        if (gi != null) arr[gi] += z.secs / 60;
      }
    });
    byKey.set(key, arr);
  }

  const wattBounds = ftp ? [Math.round(ftp * 0.75), Math.round(ftp), Math.round(ftp)] : null;

  const outRows = [];
  for (const [key, minutes] of byKey) {
    const [week, sport] = key.split('\u0000');
    outRows.push({ week, sport, minutes: minutes.map((m) => Math.round(m)) });
  }

  return {
    weeks: canonicalWeeks,
    zoneIds: POWER_ZONE_GROUP_IDS,
    wattBounds,
    sports: [...sportsSeen].sort(),
    rows: outRows,
  };
}

// ------------------------------------------------------------
// Efficiency Factor hebdomadaire — Vélo (puissance/FC) & CAP (GAP/FC)
// ------------------------------------------------------------
function buildEfficiencyChart(f, canonicalWeeks) {
  const bikeRows = f.filter(
    (a) => a.date && BIKE_TYPES.has(normalizeSportKey(a.type)) && a.icu_efficiency_factor != null && a.icu_efficiency_factor > 0
  );
  const runRows = f
    .filter((a) => a.date && RUN_TRAIL.has(normalizeSportKey(a.type)) && a.gap != null && a.gap > 0 && a.average_heartrate > 0)
    .map((a) => ({ date: a.date, ef: a.gap / a.average_heartrate }));

  const bikeByWeek = groupMean(bikeRows, (a) => weekStartMonday(a.date), (a) => a.icu_efficiency_factor);
  const runByWeek = groupMean(runRows, (r) => weekStartMonday(r.date), (r) => r.ef);

  return {
    weeks: canonicalWeeks,
    bike: canonicalWeeks.map((w) => (bikeByWeek.has(w) ? Math.round(bikeByWeek.get(w) * 100) / 100 : null)),
    run: canonicalWeeks.map((w) => (runByWeek.has(w) ? Math.round(runByWeek.get(w) * 1000) / 1000 : null)),
  };
}

// ------------------------------------------------------------
// HRV + FC de repos quotidiennes, moyenne mobile 7j + détection descriptive de tendance
// ------------------------------------------------------------
const WELLNESS_HRV_DROP_PCT = -5;
const WELLNESS_RHR_RISE_PCT = 5;

function rolling7(rows, field) {
  return rows.map((r, i) => {
    const start = Math.max(0, i - 6);
    return mean(rows.slice(start, i + 1).map((x) => x[field]));
  });
}

/** Delta (%) entre la moyenne des 7 derniers jours d'une fenêtre et la moyenne des 21 jours qui précèdent. */
function trendDeltaPct(rows, field) {
  const n = rows.length;
  if (n < 8) return null;
  const recent = mean(rows.slice(Math.max(0, n - 7)).map((r) => r[field]));
  const baseline = mean(rows.slice(Math.max(0, n - 28), Math.max(0, n - 7)).map((r) => r[field]));
  if (recent == null || !baseline) return null;
  return ((recent - baseline) / baseline) * 100;
}

/** Analyse de tendance simple et descriptive (pas de diagnostic) : détecte HRV en baisse, FC repos en
 * hausse, la combinaison des deux, ou un retour vers la baseline après un écart récent. */
function computeWellnessTrend(rows) {
  if (rows.length < 15) return null;

  const hrvDeltaPct = trendDeltaPct(rows, 'hrv');
  const rhrDeltaPct = trendDeltaPct(rows, 'rhr');
  if (hrvDeltaPct == null && rhrDeltaPct == null) return null;

  const hrvDown = hrvDeltaPct != null && hrvDeltaPct <= WELLNESS_HRV_DROP_PCT;
  const rhrUp = rhrDeltaPct != null && rhrDeltaPct >= WELLNESS_RHR_RISE_PCT;

  // Statut de tendance tel qu'il aurait été calculé il y a 7 jours, pour détecter un "retour vers la
  // baseline" (écart présent auparavant, résorbé aujourd'hui).
  let wasAbnormal = false;
  if (rows.length >= 35) {
    const prevRows = rows.slice(0, rows.length - 7);
    const prevHrvDelta = trendDeltaPct(prevRows, 'hrv');
    const prevRhrDelta = trendDeltaPct(prevRows, 'rhr');
    wasAbnormal =
      (prevHrvDelta != null && prevHrvDelta <= WELLNESS_HRV_DROP_PCT) || (prevRhrDelta != null && prevRhrDelta >= WELLNESS_RHR_RISE_PCT);
  }

  let status;
  let message;
  if (hrvDown && rhrUp) {
    status = 'both';
    message =
      "HRV en baisse et FC de repos en hausse par rapport à la tendance des dernières semaines — signe descriptif de fatigue accumulée, à replacer dans le contexte (charge récente, sommeil, stress).";
  } else if (hrvDown) {
    status = 'hrvDown';
    message = 'HRV en baisse par rapport à la tendance habituelle des dernières semaines.';
  } else if (rhrUp) {
    status = 'rhrUp';
    message = 'FC de repos en hausse par rapport à la tendance habituelle des dernières semaines.';
  } else if (wasAbnormal) {
    status = 'returning';
    message = 'Retour vers la tendance habituelle (HRV / FC de repos) après un écart récent.';
  } else {
    status = 'normal';
    message = 'HRV et FC de repos dans la tendance habituelle.';
  }

  return { status, message, hrvDeltaPct, rhrDeltaPct };
}

async function buildWellnessChart(apiKey, athleteId, historyStart, historyEnd, pStart, pEnd) {
  const empty = { dates: [], hrv: [], hrvRoll7: [], rhr: [], rhrRoll7: [], trend: null };
  let raw;
  try {
    raw = await fetchWellness(apiKey, historyStart, historyEnd, athleteId);
  } catch (e) {
    return empty;
  }
  if (!raw || !raw.length) return empty;

  const rows = raw
    .map((w) => ({ date: w.id, hrv: NUM_OR_NULL(w.hrv), rhr: NUM_OR_NULL(w.restingHR) }))
    .filter((r) => r.date && (r.hrv != null || r.rhr != null))
    .sort((a, b) => compareIso(a.date, b.date));
  if (!rows.length) return empty;

  const hrvRoll7 = rolling7(rows, 'hrv');
  const rhrRoll7 = rolling7(rows, 'rhr');
  const trend = computeWellnessTrend(rows);

  const display = [];
  for (let i = 0; i < rows.length; i++) {
    if (compareIso(rows[i].date, pStart) < 0 || compareIso(rows[i].date, pEnd) > 0) continue;
    display.push({ date: rows[i].date, hrv: rows[i].hrv, rhr: rows[i].rhr, hrvRoll7: hrvRoll7[i], rhrRoll7: rhrRoll7[i] });
  }

  return {
    dates: display.map((r) => r.date),
    hrv: display.map((r) => r.hrv),
    hrvRoll7: display.map((r) => r.hrvRoll7),
    rhr: display.map((r) => r.rhr),
    rhrRoll7: display.map((r) => r.rhrRoll7),
    trend,
  };
}

async function buildDashboardData({
  apiKey,
  athleteId = '0',
  historyStart,
  historyEnd,
  periodStart,
  periodEnd,
  types,
  forecastWeeks = 52,
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
  let futureRaw = [];
  try {
    // Aligné sur le lundi de la semaine en cours : sinon, quand "aujourd'hui" n'est pas un lundi,
    // la dernière semaine de projection est coupée en milieu de semaine et les séances planifiées
    // en fin de semaine (jeudi-dimanche) sont exclues du fetch -> semaine sous-estimée (km/D+/heures/ACWR).
    const forecastEnd = addDaysIso(weekStartMonday(todayIso()), forecastWeeks * 7 - 1);
    futureRaw = await fetchCalendarEvents(apiKey, historyStart, forecastEnd, athleteId);
    forecast = buildForecast(futureRaw);
  } catch (e) {
    forecastError = e.message;
  }

  const currentWeekSessions = buildCurrentWeekSessions(futureRaw, df);

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
  // buildForecast n'exclut de forecastDaily que les séances déjà liées via paired_activity_id, mais ce
  // lien Intervals.icu n'est pas toujours fait (délai de sync, sport différent du prévu, séance
  // avancée/reculée...). Sans ça, une séance réellement faite un jour >= aujourd'hui reste comptée
  // en "restant" EN PLUS de sa charge réelle déjà comptabilisée -> restante/projetée surestimées.
  // Donc on exclut aussi toute date qui a déjà une activité réelle enregistrée, peu importe le lien.
  const realActivityDates = new Set(df.filter((a) => a.date && a.foster_load > 0).map((a) => a.date));
  const futureDaily = forecast.forecastDaily.filter(
    (d) => compareIso(d.date, today) >= 0 && !realActivityDates.has(d.date)
  );
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
  // TRIMP (+ planifié) / zones FC / zones puissance / Efficiency Factor / HRV+RHR
  // ------------------------------------------------------------
  const canonicalWeeks = metricsDisplay.map((m) => m.week);
  const plannedTrimpByWeek = buildPlannedTrimpByWeek(futureRaw, dfUntilPeriodEnd, realActivityDates, today);
  const trimpChart = buildTrimpChart(dfUntilPeriodEnd, loadBarWeeks, plannedTrimpByWeek);
  const hrZoneChart = buildHrZoneChart(f, canonicalWeeks);
  const efficiencyChart = buildEfficiencyChart(f, canonicalWeeks);

  let athleteProfile = null;
  let wellnessChart = { dates: [], hrv: [], hrvRoll7: [], rhr: [], rhrRoll7: [], trend: null };
  try {
    [athleteProfile, wellnessChart] = await Promise.all([
      fetchAthleteProfile(apiKey, athleteId).catch(() => null),
      buildWellnessChart(apiKey, athleteId, historyStart, historyEnd, pStart, pEnd),
    ]);
  } catch (e) {
    // Défensif : ces métriques ne doivent jamais faire échouer tout le dashboard (ex: compte sans
    // accès au profil / au bien-être, ou API momentanément indisponible).
  }
  const powerZoneChart = buildPowerZoneChart(f, canonicalWeeks, athleteProfile);

  return {
    empty: false,
    meta: { minDate, maxDate, allTypes, selectedTypes, periodStart: pStart, periodEnd: pEnd },
    kpis,
    sportFosterChart,
    capChart,
    bikeChart,
    acwrChart,
    trimpChart,
    hrZoneChart,
    powerZoneChart,
    efficiencyChart,
    wellnessChart,
    currentWeekSessions,
    notes: forecast.notes,
    forecastError,
    debugRaw: forecast.debugRaw,
  };
}

module.exports = { buildDashboardData };
