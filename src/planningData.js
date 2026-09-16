'use strict';

const { fetchIntervalsEvents, fetchCalendarEvents, fetchWorkoutLibrary, fetchWorkoutFolders, fetchActivityIntervals, fetchAthleteProfile } = require('./intervalsApi');
const { prepareActivities, calculatePlanningTargets, effectiveRpeForPlanned } = require('./calculations');
const { dateOnly, addDaysIso, weekStartMonday, todayIso, compareIso } = require('./dateUtils');
const { fmtTime } = require('./format');
const sessionLoad = require('./sessionLoad.json');

const NUM = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/**
 * Charge Foster totale déjà planifiée (calendrier Intervals.icu) sur l'ensemble de la semaine en
 * cours (réalisée ou non) — sert de projection "pure plan" pour l'ACWR prévisionnel de la semaine
 * en cours, cohérente avec le même calcul côté dashboard (totalPlannedDaily).
 */
async function getCurrentWeekPlannedTotal(apiKey, athleteId) {
  const weekStart = weekStartMonday(todayIso());
  const weekEnd = addDaysIso(weekStart, 6);
  const raw = await fetchCalendarEvents(apiKey, weekStart, weekEnd, athleteId);
  if (!raw?.length) return 0;

  return raw
    .filter((e) => ['WORKOUT', 'PLAN'].includes(String(e.category || '').toUpperCase()))
    .reduce((sum, e) => sum + (effectiveRpeForPlanned(e.type, e.name, e.icu_rpe) * NUM(e.moving_time, 0)) / 60, 0);
}

/** Charge chronique actuelle (pour le planificateur de semaine). */
async function getChronicLoad(apiKey, athleteId, historyStart, historyEnd) {
  const rawEvents = await fetchIntervalsEvents(apiKey, historyStart, historyEnd, athleteId);
  const df = prepareActivities(rawEvents);
  if (!df.length) return null;

  const targets = calculatePlanningTargets(df);
  if (!targets) return null;

  let currentWeekPlannedTotal = 0;
  try {
    currentWeekPlannedTotal = await getCurrentWeekPlannedTotal(apiKey, athleteId);
  } catch (_) {
    // Aide au calcul uniquement : une erreur ici ne doit pas bloquer l'affichage de la charge chronique.
  }

  return { ...targets, currentWeekPlannedTotal };
}

/**
 * Séances planifiées existantes (catégories WORKOUT / PLAN) sur une période, enrichies du statut de
 * réalisation (`done`/`missed`/`today`/`upcoming`, via le lien `paired_activity_id` -> activité réelle,
 * même logique que dashboardData.js's buildCurrentWeekSessions) et du % de complétion de la charge
 * Foster prévue vs réellement effectuée — sert au code couleur des séances passées côté calendrier.
 * Inclut aussi les activités réelles non planifiées ("hors plan", `status: 'extra'`) de la période.
 */
async function getPlannedCalendar(apiKey, athleteId, start, end) {
  const raw = await fetchCalendarEvents(apiKey, start, end, athleteId);
  const rawActivities = await fetchIntervalsEvents(apiKey, start, end, athleteId);
  const df = prepareActivities(rawActivities);
  const dfById = new Map(df.filter((a) => a.id != null).map((a) => [String(a.id), a]));
  const today = todayIso();

  const plannedRaw = (raw || []).filter((e) => ['WORKOUT', 'PLAN'].includes(String(e.category || '').toUpperCase()));

  const linkedActivityIds = new Set(
    plannedRaw.filter((e) => e.paired_activity_id != null).map((e) => String(e.paired_activity_id))
  );

  const planned = plannedRaw.map((e) => {
    const date = dateOnly(e.start_date_local || e.start_date);
    const movingTime = e.moving_time || 0;
    // rpe effectif (icu_rpe réel s'il existe, sinon heuristique par nom/sport) : même logique que le
    // dashboard/aide-planif pour que la charge Foster affichée soit cohérente partout.
    const rpe = effectiveRpeForPlanned(e.type, e.name, e.icu_rpe);
    const plannedLoad = Math.round((rpe * movingTime) / 60);
    // Intervals.icu ne renvoie PAS `activity_id` sur les événements calendrier réalisés : le lien
    // vers l'activité réelle se fait via `paired_activity_id` (id de l'activité, ex. "i123456").
    const real = e.paired_activity_id != null ? dfById.get(String(e.paired_activity_id)) : null;
    const done = !!real;

    let status;
    if (done) status = 'done';
    else if (compareIso(date, today) < 0) status = 'missed';
    else if (date === today) status = 'today';
    else status = 'upcoming';

    const realLoad = real ? Math.round(real.foster_load) : null;
    const completionPct = plannedLoad > 0 ? Math.round(((realLoad || 0) / plannedLoad) * 100) : null;

    return {
      id: e.id ?? null,
      date,
      name: e.name || '',
      type: e.type || '',
      description: e.description || '',
      temps: movingTime ? fmtTime(movingTime) : '',
      movingTime,
      rpe,
      trainingLoad: e.icu_training_load ?? null,
      externalId: e.external_id ?? '',
      activityId: e.paired_activity_id ?? null,
      status,
      plannedLoad,
      realLoad,
      completionPct,
      realRpe: real ? real.icu_rpe : null,
      realMovingTime: real ? real.moving_time : null,
      realDistanceM: real ? real.distance : null,
      realElevationM: real ? real.total_elevation_gain : null,
      realAvgSpeedMs: real && Number.isFinite(real.average_speed) ? real.average_speed : null,
      realAvgWatts: real && Number.isFinite(real.icu_average_watts) ? Math.round(real.icu_average_watts) : null,
      realNormPower: real && Number.isFinite(real.icu_weighted_avg_watts) ? Math.round(real.icu_weighted_avg_watts) : null,
      realNote: real ? real.description || '' : '',
    };
  });

  // Activités réelles jamais liées à un événement planifié (catégorie de sport réel, jamais
  // WORKOUT/PLAN puisque prepareActivities les exclut déjà) — affichées à part comme "hors plan".
  const extra = df
    .filter((a) => a.id != null && !linkedActivityIds.has(String(a.id)))
    .map((a) => ({
      id: `activity-${a.id}`,
      date: a.date,
      name: a.name || '',
      type: a.type || '',
      description: a.description || '',
      temps: a.moving_time ? fmtTime(a.moving_time) : '',
      movingTime: a.moving_time || 0,
      rpe: null,
      trainingLoad: null,
      externalId: '',
      activityId: a.id,
      status: 'extra',
      plannedLoad: null,
      realLoad: Math.round(a.foster_load || 0),
      completionPct: null,
      realRpe: a.icu_rpe ?? null,
      realMovingTime: a.moving_time || null,
      realDistanceM: a.distance ?? null,
      realElevationM: a.total_elevation_gain ?? null,
      realAvgSpeedMs: Number.isFinite(a.average_speed) ? a.average_speed : null,
      realAvgWatts: Number.isFinite(a.icu_average_watts) ? Math.round(a.icu_average_watts) : null,
      realNormPower: Number.isFinite(a.icu_weighted_avg_watts) ? Math.round(a.icu_weighted_avg_watts) : null,
      realNote: a.description || '',
    }));

  return [...planned, ...extra].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

const RACE_CATEGORIES = ['RACE_A', 'RACE_B', 'RACE_C'];

/** Comme getPlannedCalendar, mais inclut aussi les courses (RACE_A/B/C) — utilisé uniquement par
 * l'export CSV du planning ; l'affichage calendrier (getPlannedCalendar) continue lui de les exclure. */
async function getPlannedCalendarWithRaces(apiKey, athleteId, start, end) {
  const raw = await fetchCalendarEvents(apiKey, start, end, athleteId);
  if (!raw || !raw.length) return [];

  return raw
    .filter((e) => ['WORKOUT', 'PLAN', ...RACE_CATEGORIES].includes(String(e.category || '').toUpperCase()))
    .map((e) => {
      const category = String(e.category || '').toUpperCase();
      const isRace = RACE_CATEGORIES.includes(category);
      return {
        id: e.id ?? null,
        date: dateOnly(e.start_date_local || e.start_date),
        name: e.name || '',
        type: e.type || '',
        category,
        description: e.description || '',
        temps: e.moving_time ? fmtTime(e.moving_time) : '',
        movingTime: e.moving_time || 0,
        rpe: isRace ? sessionLoad.race.rpe : effectiveRpeForPlanned(e.type, e.name, e.icu_rpe),
        trainingLoad: e.icu_training_load ?? null,
        externalId: e.external_id ?? '',
      };
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/**
 * Aplati récursivement l'arborescence de dossiers Intervals.icu en une liste de dossiers
 * {id, name, path} et un Map<workoutId, folderPath> pour ranger les séances de la bibliothèque.
 */
function flattenWorkoutFolders(nodes, parentPath = []) {
  const folders = [];
  const workoutFolderPath = new Map();
  for (const node of nodes || []) {
    if (String(node.type).toUpperCase() === 'FOLDER') {
      const path = [...parentPath, node.name || 'Sans nom'];
      folders.push({ id: node.id, name: node.name || 'Sans nom', path: path.join(' / ') });
      const nested = flattenWorkoutFolders(node.children, path);
      folders.push(...nested.folders);
      for (const [wid, wpath] of nested.workoutFolderPath) workoutFolderPath.set(wid, wpath);
    } else if (node && node.id != null) {
      workoutFolderPath.set(node.id, parentPath.join(' / '));
    }
  }
  return { folders, workoutFolderPath };
}

/**
 * Bibliothèque de séances Intervals.icu, TOUJOURS lue sur le compte principal (athlete "0") :
 * la bibliothèque appartient au coach, pas à l'athlète actuellement sélectionné dans le sélecteur
 * (un athlète coaché n'a le plus souvent aucune séance dans sa propre bibliothèque), donc changer
 * d'athlète ne doit jamais la vider. Chaque séance est annotée avec son dossier/sous-dossier
 * Intervals.icu (folderPath) pour permettre de les ranger dans l'UI.
 */
async function getWorkoutLibrary(apiKey) {
  const [workouts, folderTree] = await Promise.all([fetchWorkoutLibrary(apiKey, '0'), fetchWorkoutFolders(apiKey, '0')]);
  const { folders, workoutFolderPath } = flattenWorkoutFolders(folderTree);

  return {
    folders,
    workouts: workouts.map((w) => ({ ...w, folderPath: workoutFolderPath.get(w.id) || '' })),
  };
}

// WORK/RECOVERY volontairement omis (pas de traduction) : ne jamais retomber sur `iv.type` brut en
// dessous, sinon ces valeurs Intervals.icu non traduites ("WORK"/"RECOVERY") refont surface telles quelles.
const INTERVAL_TYPE_LABELS = { WARMUP: 'Échauffement', COOLDOWN: 'Retour au calme', REST: 'Repos' };

const G = 9.81; // accélération de la pesanteur (m/s²)
const BIKE_MASS_KG = 8; // masse vélo approximative, ajoutée au poids du cycliste pour la physique
const RUN_COST_PER_M = 1.0; // J/kg/m : coût mécanique approximatif de la course à plat (~1/4 du coût métabolique ~1 kcal/kg/km)
const RIDE_CRR = 0.005; // coefficient de résistance au roulement (route)
const RIDE_CDA = 0.3; // aire frontale x Cx approximative (position cocottes)
const AIR_DENSITY = 1.225; // kg/m³, niveau de la mer

/**
 * Quand Intervals.icu n'a pas mesuré de puissance sur l'intervalle (pas de capteur), estimation
 * physique grossière à partir du poids de l'athlète, du D+, du temps et de la distance : puissance
 * d'ascension (poids × g × D+ / temps) + puissance horizontale (coût de la course pour la CAP,
 * frottements de roulement + traînée aérodynamique pour le vélo, avec des constantes fixes — pas de
 * vent/position/Crr réels). Approximation à ne jamais présenter comme une mesure exacte.
 */
function estimateAvgWatts({ sportKey, weightKg, distanceM, elevationGainM, movingTimeS }) {
  if (!(weightKg > 0) || movingTimeS <= 0) return null;
  const speedMs = distanceM > 0 ? distanceM / movingTimeS : 0;
  const gain = elevationGainM || 0;

  if (sportKey === 'Ride') {
    const mass = weightKg + BIKE_MASS_KG;
    const climbW = (mass * G * gain) / movingTimeS;
    const rollW = RIDE_CRR * mass * G * speedMs;
    const aeroW = 0.5 * AIR_DENSITY * RIDE_CDA * speedMs ** 3;
    return Math.round(climbW + rollW + aeroW);
  }
  if (sportKey === 'Run') {
    const climbW = (weightKg * G * gain) / movingTimeS;
    const flatW = weightKg * RUN_COST_PER_M * speedMs;
    return Math.round(climbW + flatW);
  }
  return null;
}

/**
 * Détail par intervalle (splits/laps calculés par Intervals.icu) d'une activité réelle, pour
 * l'analyse avancée d'une séance. Intervals.icu ne fournit pas la perte d'altitude par intervalle
 * (seulement le gain net) : `elevationLossM` est donc une approximation à partir de la pente
 * moyenne quand elle est négative (descente nette sur l'intervalle).
 */
async function getActivityIntervals(apiKey, activityId, { athleteId = '0', sportKey } = {}) {
  const [raw, profile] = await Promise.all([
    fetchActivityIntervals(apiKey, activityId),
    fetchAthleteProfile(apiKey, athleteId).catch(() => null),
  ]);
  const list = raw && Array.isArray(raw.icu_intervals) ? raw.icu_intervals : [];
  const weightKg = profile && Number.isFinite(profile.icu_weight) ? profile.icu_weight : null;

  return list
    .filter((iv) => NUM(iv.distance, 0) > 0 || NUM(iv.moving_time, 0) > 0)
    .map((iv, i) => {
      const distanceM = NUM(iv.distance, 0);
      const movingTime = NUM(iv.moving_time, 0);
      const elevationGainM = NUM(iv.total_elevation_gain, 0);
      const elevationLossM = iv.average_gradient < 0 ? Math.round(Math.abs(iv.average_gradient * distanceM)) : 0;
      const vamMh = elevationGainM > 0 && movingTime > 0 ? Math.round((elevationGainM / movingTime) * 3600) : null;
      const measuredWatts = Number.isFinite(iv.average_watts) ? Math.round(iv.average_watts) : null;
      const avgWatts =
        measuredWatts ??
        estimateAvgWatts({ sportKey, weightKg, distanceM, elevationGainM, movingTimeS: movingTime });

      return {
        index: i + 1,
        typeLabel: INTERVAL_TYPE_LABELS[iv.type] || '',
        distanceM,
        movingTime,
        elevationGainM,
        elevationLossM,
        vamMh,
        avgSpeedMs: Number.isFinite(iv.average_speed) ? iv.average_speed : null,
        avgWatts,
        wattsEstimated: measuredWatts == null && avgWatts != null,
        avgHr: Number.isFinite(iv.average_heartrate) ? Math.round(iv.average_heartrate) : null,
        maxHr: Number.isFinite(iv.max_heartrate) ? Math.round(iv.max_heartrate) : null,
      };
    });
}

module.exports = { getChronicLoad, getPlannedCalendar, getPlannedCalendarWithRaces, getWorkoutLibrary, getActivityIntervals };
