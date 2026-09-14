'use strict';

const { fetchIntervalsEvents, fetchCalendarEvents, fetchWorkoutLibrary, fetchWorkoutFolders } = require('./intervalsApi');
const { prepareActivities, calculatePlanningTargets, effectiveRpeForPlanned } = require('./calculations');
const { dateOnly, addDaysIso, weekStartMonday, todayIso } = require('./dateUtils');
const { fmtTime } = require('./format');

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

/** Séances planifiées existantes (catégories WORKOUT / PLAN) sur une période. */
async function getPlannedCalendar(apiKey, athleteId, start, end) {
  const raw = await fetchCalendarEvents(apiKey, start, end, athleteId);
  if (!raw || !raw.length) return [];

  return raw
    .filter((e) => ['WORKOUT', 'PLAN'].includes(String(e.category || '').toUpperCase()))
    .map((e) => ({
      id: e.id ?? null,
      date: dateOnly(e.start_date_local || e.start_date),
      name: e.name || '',
      type: e.type || '',
      description: e.description || '',
      temps: e.moving_time ? fmtTime(e.moving_time) : '',
      movingTime: e.moving_time || 0,
      // rpe effectif (icu_rpe réel s'il existe, sinon heuristique par nom/sport) : même logique que le
      // dashboard/aide-planif pour que la charge Foster affichée soit cohérente partout.
      rpe: effectiveRpeForPlanned(e.type, e.name, e.icu_rpe),
      trainingLoad: e.icu_training_load ?? null,
      externalId: e.external_id ?? '',
    }))
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

module.exports = { getChronicLoad, getPlannedCalendar, getWorkoutLibrary };
