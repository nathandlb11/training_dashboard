'use strict';

const { fetchIntervalsEvents, fetchCalendarEvents } = require('./intervalsApi');
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

module.exports = { getChronicLoad, getPlannedCalendar };
