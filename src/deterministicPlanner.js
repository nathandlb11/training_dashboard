'use strict';

const { sportForWorkoutType, effectiveRpeForPlanned } = require('./calculations');
const { parseDescriptionDurationMinutes, hasRepeatBlock, scaleDescriptionDuration } = require('./format');

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function workoutDurationMin(w) {
  const parsed = parseDescriptionDurationMinutes(w.description);
  if (parsed > 0) return parsed;
  return w.moving_time > 0 ? Math.round(w.moving_time / 60) : 0;
}

/** Repère, dans la bibliothèque Intervals.icu, le footing (séance simple la plus courte), la sortie
 * longue (séance simple la plus longue) et les séances de qualité (bloc d'intervalles) disponibles. */
function categorizeRunLibrary(runWorkouts) {
  const simple = runWorkouts.filter((w) => !hasRepeatBlock(w.description)).sort((a, b) => workoutDurationMin(a) - workoutDurationMin(b));
  const quality = runWorkouts.filter((w) => hasRepeatBlock(w.description));
  return { footing: simple[0] || null, longRun: simple[simple.length - 1] || null, quality };
}

/** Détermine les "slots" course à pied à remplir : à partir de 3 séances, minimum footing + sortie
 * longue + qualité (sautée en décharge) ; en dessous de 3, pas d'obligation. Le reste est comblé de
 * footing, comme un footing/EF supplémentaire plutôt qu'une 2e qualité (simplification volontaire). */
function planRunSlots(nRun, planningType, hasQuality) {
  if (nRun <= 0) return [];
  if (nRun === 1) return ['long'];
  if (nRun === 2) return ['footing', 'long'];
  const slots = ['footing', 'long'];
  if (hasQuality && planningType !== 'Récupération') slots.splice(1, 0, 'quality');
  while (slots.length < nRun) slots.splice(-1, 0, 'footing');
  return slots.slice(0, nRun);
}

const RUN_KIND_WEIGHT = { footing: 0.8, quality: 1.3, long: 1.6 };

const DAY_PREF = {
  long: [6, 7, 5, 4, 3, 2, 1],
  quality: [2, 4, 3, 5, 1, 6, 7],
  Strength: [1, 5, 3, 2, 4, 6, 7],
  Ride: [3, 5, 7, 2, 4, 6, 1],
  footing: [1, 3, 5, 2, 4, 6, 7],
};

/** Assigne un jour (1-7) à chaque séance selon des préférences par type, puis décale tout renfo collé
 * à une sortie longue — même filet de sécurité que enforceStrengthSpacing dans aiPlanner.js. */
function assignDays(sessions) {
  const priority = { long: 0, quality: 1, Strength: 2, Ride: 3, footing: 4 };
  const ordered = sessions.slice().sort((a, b) => (priority[a.kind] ?? 5) - (priority[b.kind] ?? 5));
  const used = new Set();
  for (const s of ordered) {
    const pref = DAY_PREF[s.kind] || [1, 2, 3, 4, 5, 6, 7];
    s.dayOfWeek = pref.find((d) => !used.has(d)) ?? pref[0];
    used.add(s.dayOfWeek);
  }

  const longDays = sessions.filter((s) => s.kind === 'long').map((s) => s.dayOfWeek);
  if (!longDays.length) return sessions;
  const conflicts = (d) => longDays.some((ld) => Math.abs(ld - d) === 1);
  for (const s of sessions) {
    if (s.kind !== 'Strength' || !conflicts(s.dayOfWeek)) continue;
    const alt = [1, 2, 3, 4, 5, 6, 7].find((d) => !conflicts(d) && !used.has(d)) || [1, 2, 3, 4, 5, 6, 7].find((d) => !conflicts(d));
    if (alt && alt !== s.dayOfWeek) {
      used.delete(s.dayOfWeek);
      s.dayOfWeek = alt;
      used.add(alt);
    }
  }
  return sessions;
}

const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

/** Construit, SANS IA, une semaine cohérente à partir de règles fixes et de la bibliothèque Intervals.icu
 * réelle du compte : mêmes contraintes que le prompt IA (footing/sortie longue/qualité obligatoires à
 * partir de 3 séances course, qualité sautée en décharge, sortie longue toujours ≥ footing +50%, charge
 * répartie par poids entre les séances course pour approcher la charge cible). */
function generateDeterministicWeekPlan({ planningType, nRun, nBike, nStrength, chronicLoad, targetAcwr, workoutLibrary }) {
  const library = Array.isArray(workoutLibrary) ? workoutLibrary : [];
  const runWorkouts = library.filter((w) => sportForWorkoutType(w.type) === 'Run');
  const rideWorkouts = library.filter((w) => sportForWorkoutType(w.type) === 'Ride' && !hasRepeatBlock(w.description));

  const { footing, longRun, quality } = categorizeRunLibrary(runWorkouts);
  const rideWorkout = rideWorkouts.slice().sort((a, b) => workoutDurationMin(a) - workoutDurationMin(b))[0] || null;

  const targetLoad = Math.round((Number(chronicLoad) || 0) * (Number(targetAcwr) || 0));
  const nBikeUsed = rideWorkout ? clamp(Math.round(Number(nBike) || 0), 0, 8) : 0;
  const nStrengthUsed = clamp(Math.round(Number(nStrength) || 0), 0, 6);
  const nRunUsed = clamp(Math.round(Number(nRun) || 0), 0, 8);

  const strengthDurationMin = 35;
  const strengthRpe = 7;
  const bikeDurationMin = rideWorkout ? workoutDurationMin(rideWorkout) : 0;
  const bikeRpe = rideWorkout ? effectiveRpeForPlanned(rideWorkout.type, rideWorkout.name, rideWorkout.icu_rpe) : 0;

  const fixedLoad = nBikeUsed * bikeDurationMin * bikeRpe + nStrengthUsed * strengthDurationMin * strengthRpe;
  const runLoadTarget = Math.max(0, targetLoad - fixedLoad);

  const slots = planRunSlots(nRunUsed, planningType, quality.length > 0);
  const slotWorkout = { footing, long: longRun, quality: quality[0] || null };
  const usableSlots = slots.filter((kind) => slotWorkout[kind]);
  const totalWeight = usableSlots.reduce((sum, kind) => sum + (RUN_KIND_WEIGHT[kind] || 1), 0) || 1;

  const sessions = [];
  let footingDurationMin = null;
  for (const kind of usableSlots) {
    const workout = slotWorkout[kind];
    const rpe = effectiveRpeForPlanned(workout.type, workout.name, workout.icu_rpe) || 1;
    let durationMin = (runLoadTarget * (RUN_KIND_WEIGHT[kind] || 1)) / totalWeight / rpe;
    if (kind === 'footing') footingDurationMin = durationMin;
    // La sortie longue doit toujours rester ≥ footing +50%, même si le poids/charge la ferait sinon
    // plus courte (ex. très peu de charge cible restante après vélo/renfo fixes).
    if (kind === 'long' && footingDurationMin) durationMin = Math.max(durationMin, footingDurationMin * 1.5);

    const description = scaleDescriptionDuration(workout.description || '', clamp(Math.round(durationMin), 10, 240));
    sessions.push({
      kind,
      sport: 'Run',
      name: workout.name,
      durationMin: parseDescriptionDurationMinutes(description) || workoutDurationMin(workout),
      rpe,
      description,
    });
  }

  for (let i = 0; i < nBikeUsed; i++) {
    sessions.push({ kind: 'Ride', sport: 'Ride', name: rideWorkout.name, durationMin: bikeDurationMin, rpe: bikeRpe, description: rideWorkout.description || '' });
  }
  for (let i = 0; i < nStrengthUsed; i++) {
    sessions.push({
      kind: 'Strength',
      sport: 'Strength',
      name: nStrengthUsed > 1 ? `Musculation ${i + 1}` : 'Musculation',
      durationMin: strengthDurationMin,
      rpe: strengthRpe,
      description: '',
    });
  }

  if (!sessions.length) throw new Error('Bibliothèque Intervals.icu vide : aucune séance déterministe possible.');

  assignDays(sessions);
  sessions.sort((a, b) => a.dayOfWeek - b.dayOfWeek);

  const rationale =
    sessions.map((s) => `${DAY_NAMES[s.dayOfWeek - 1]} : ${s.name} (${s.sport}, ${Math.round(s.durationMin)}min)`).join(' ; ') +
    `. Répartition déterministe (sans IA, règles fixes) à partir de la bibliothèque Intervals.icu — charge cible ≈ ${targetLoad} AU.`;

  return { sessions: sessions.map(({ kind, ...s }) => ({ ...s, durationMin: Math.round(s.durationMin) })), rationale };
}

module.exports = { generateDeterministicWeekPlan };
