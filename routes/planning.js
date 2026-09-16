'use strict';

const express = require('express');
const {
  createOrUpdateCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
} = require('../src/intervalsApi');
const { getAthleteOptions } = require('../src/athletes');
const { getChronicLoad, getPlannedCalendar, getPlannedCalendarWithRaces, getWorkoutLibrary, getActivityIntervals } = require('../src/planningData');
const { generateAiWeekPlan } = require('../src/aiPlanner');
const { generateDeterministicWeekPlan } = require('../src/deterministicPlanner');
const { addDaysIso, todayIso } = require('../src/dateUtils');
const { rowsToCsv } = require('../src/csvExport');

const router = express.Router();

function getApiKey() {
  return process.env.INTERVALS_API_KEY || '';
}

router.get('/planning', async (req, res) => {
  const apiKey = getApiKey();

  if (!apiKey) {
    return res.render('planning', {
      apiKeyMissing: true,
      athletes: [],
      athleteId: '0',
      chronicData: null,
      calendar: [],
      calendarStart: todayIso(),
      calendarEnd: addDaysIso(todayIso(), 28),
      historyStart: addDaysIso(todayIso(), -180),
      historyEnd: todayIso(),
      error: null,
    });
  }

  const athleteId = req.query.athleteId || '0';
  const historyStart = req.query.historyStart || addDaysIso(todayIso(), -180);
  const historyEnd = req.query.historyEnd || todayIso();
  const calendarStart = req.query.calendarStart || todayIso();
  const calendarEnd = req.query.calendarEnd || addDaysIso(todayIso(), 28);

  let athletes = [];
  let chronicData = null;
  let calendar = [];
  let error = null;

  try {
    athletes = await getAthleteOptions(apiKey);
    chronicData = await getChronicLoad(apiKey, athleteId, historyStart, historyEnd);
    calendar = await getPlannedCalendar(apiKey, athleteId, calendarStart, calendarEnd);
  } catch (e) {
    error = e.message;
  }

  res.render('planning', {
    apiKeyMissing: false,
    athletes,
    athleteId,
    chronicData,
    calendar,
    calendarStart,
    calendarEnd,
    historyStart,
    historyEnd,
    error,
  });
});

router.get('/api/planning/calendar', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', start, end } = req.query;
    const calendar = await getPlannedCalendar(apiKey, athleteId, start, end);
    res.json({ calendar });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/planning/activity/:id/intervals', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', sportKey } = req.query;
    const intervals = await getActivityIntervals(apiKey, req.params.id, { athleteId, sportKey });
    res.json({ intervals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/planning/export-csv', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const athleteId = req.query.athleteId || '0';
    // Planning à venir uniquement : jamais avant aujourd'hui, mais fenêtre future large pour couvrir
    // tout ce qui est déjà planifié (getPlannedCalendarWithRaces filtre de toute façon aux
    // catégories WORKOUT/PLAN/RACE_*).
    const start = req.query.start || todayIso();
    const end = req.query.end || addDaysIso(todayIso(), 730);

    const calendar = await getPlannedCalendarWithRaces(apiKey, athleteId, start, end);

    const RACE_LABELS = { RACE_A: 'Course A', RACE_B: 'Course B', RACE_C: 'Course C' };

    const csv = rowsToCsv(
      [
        { header: 'Date', key: 'date' },
        { header: 'Catégorie', value: (e) => RACE_LABELS[e.category] || 'Séance' },
        { header: 'Nom', key: 'name' },
        { header: 'Type', key: 'type' },
        { header: 'Durée', key: 'temps' },
        { header: 'RPE', key: 'rpe' },
        { header: 'Charge Foster estimée', value: (e) => Math.round(((e.rpe || 0) * (e.movingTime || 0)) / 60) },
        { header: 'Charge Intervals.icu prévue', key: 'trainingLoad' },
        { header: 'Description', key: 'description' },
      ],
      calendar
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planning_${start}_${end}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/planning/chronic', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', historyStart, historyEnd } = req.query;
    const chronicData = await getChronicLoad(apiKey, athleteId, historyStart, historyEnd);
    res.json({ chronicData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/planning/workouts', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    // Toujours le compte principal (voir getWorkoutLibrary) : la bibliothèque ne dépend pas de
    // l'athlète sélectionné dans l'UI.
    const { workouts, folders } = await getWorkoutLibrary(apiKey);
    res.json({ workouts, folders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/send-bulk', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', events, confirmed } = req.body;
    if (!confirmed) return res.status(400).json({ error: "Confirmation requise avant l'envoi." });
    if (!events || !events.length) return res.status(400).json({ error: 'Aucune séance à envoyer.' });
    const result = await createOrUpdateCalendarEvents(apiKey, events, athleteId);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/event/:id/update', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', patch, confirmed } = req.body;
    if (!confirmed) return res.status(400).json({ error: 'Confirmation requise avant la modification.' });
    if (!patch) return res.status(400).json({ error: 'Modification manquante.' });
    const result = await updateCalendarEvent(apiKey, athleteId, req.params.id, patch);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/event/:id/delete', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', confirmed } = req.body;
    if (!confirmed) return res.status(400).json({ error: 'Confirmation requise avant la suppression.' });
    const result = await deleteCalendarEvent(apiKey, athleteId, req.params.id);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/send', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { athleteId = '0', event } = req.body;
    if (!event || !event.confirmed) {
      return res.status(400).json({ error: "Confirmation requise avant l'envoi." });
    }
    const payload = { ...event };
    delete payload.confirmed;

    const result = await createOrUpdateCalendarEvents(apiKey, [payload], athleteId);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/ai-week', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { week, planningType, nRun, nBike, nStrength, chronicLoad, targetAcwr, constraints, comment, recentWeeks } = req.body;
    if (!week) return res.status(400).json({ error: 'Semaine manquante.' });

    // Toujours le compte principal (voir getWorkoutLibrary) : la bibliothèque ne dépend pas de
    // l'athlète sélectionné, et sert de source unique de vérité pour contraindre l'IA (pas de
    // bibliothèque locale : uniquement les vraies séances Intervals.icu du compte).
    const { workouts } = await getWorkoutLibrary(apiKey);

    const plan = await generateAiWeekPlan({
      weekStart: week,
      planningType,
      nRun,
      nBike,
      nStrength,
      chronicLoad,
      targetAcwr,
      constraints,
      comment,
      recentWeeks,
      workoutLibrary: workouts,
    });
    res.json({ plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/planning/deterministic-week', express.json(), async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Clé API Intervals.icu manquante.' });

  try {
    const { planningType, nRun, nBike, nStrength, chronicLoad, targetAcwr } = req.body;

    // Même bibliothèque (compte principal) et mêmes règles que l'IA, mais calcul 100% déterministe
    // (aucun appel IA) — voir generateDeterministicWeekPlan.
    const { workouts } = await getWorkoutLibrary(apiKey);

    const plan = generateDeterministicWeekPlan({ planningType, nRun, nBike, nStrength, chronicLoad, targetAcwr, workoutLibrary: workouts });
    res.json({ plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
