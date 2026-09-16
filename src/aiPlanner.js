'use strict';

const axios = require('axios');
const { effectiveRpeForPlanned, sportForWorkoutType } = require('./calculations');
const { parseDescriptionDurationMinutes, hasRepeatBlock, setDescriptionReps, scaleDescriptionDuration } = require('./format');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const VALID_SPORTS = new Set(['Run', 'Ride', 'Strength']);

/** Décrit une séance de la bibliothèque Intervals.icu (durée/RPE) pour le prompt IA ; signale les
 * séances de qualité (intervalles), seules dont l'IA peut aussi ajuster le nombre de reps. */
function describeWorkout(w) {
  const durationMin = w.moving_time > 0 ? Math.round(w.moving_time / 60) : null;
  const rpe = effectiveRpeForPlanned(w.type, w.name, w.icu_rpe);
  const durationLabel = durationMin ? durationMin + 'min' : 'durée non renseignée';
  const tag = hasRepeatBlock(w.description) ? ' (qualité : durée/reps ajustables)' : ' (durée ajustable)';
  return `- ${w.name} : ${durationLabel}, RPE ${rpe}${tag}`;
}

/** Construit le bloc de prompt listant, par sport, les séances réellement disponibles dans la
 * bibliothèque Intervals.icu du compte (aucune séance locale ni inventée). */
function buildLibraryPromptBlock(workoutLibrary) {
  const runs = (workoutLibrary || []).filter((w) => sportForWorkoutType(w.type) === 'Run');
  const rides = (workoutLibrary || []).filter((w) => sportForWorkoutType(w.type) === 'Ride');

  if (!runs.length && !rides.length) {
    return "(Bibliothèque Intervals.icu vide ou indisponible pour la course à pied/vélo — aucune séance n'est disponible, propose uniquement de la musculation.)";
  }

  const parts = [];
  if (runs.length) parts.push('Course à pied :', ...runs.map(describeWorkout));
  if (runs.length && rides.length) parts.push('');
  if (rides.length) parts.push('Vélo :', ...rides.map(describeWorkout));
  return parts.join('\n');
}

/** Construit le prompt système en y interpolant la bibliothèque Intervals.icu réelle du compte
 * (récupérée à chaque appel via l'API Intervals.icu, jamais une liste locale figée). */
function buildSystemPrompt(workoutLibrary) {
  return `Tu es un coach expert en entraînement d'endurance (course à pied, trail, vélo, musculation).
La charge hebdomadaire cible t'est déjà donnée (à répartir en séances, pas à recalculer).

BIBLIOTHÈQUE (course à pied/vélo) — choisis CHAQUE séance UNIQUEMENT parmi celles-ci, nom EXACT,
INTERDICTION TOTALE d'en inventer une hors liste :
${buildLibraryPromptBlock(workoutLibrary)}
Durée ajustable ("durationMin") pour toutes ; les séances "(qualité)" acceptent aussi "reps" (nombre
d'intervalles), l'échauffement et le retour au calme suivent proportionnellement. Musculation (hors
bibliothèque) : nom libre, 30-40min, RPE 7.

MÉTHODE & RÈGLES
- Foster : charge (AU) = durée (min) x RPE (1-10). Choc : week-end choc = 2 sorties longues consécutives.
- Course à pied, à partir de 3 séances : minimum obligatoire 1 footing, 1 sortie longue (durée ≥ footing
  +50%, ou une sortie longue avec blocs actifs) et 1 qualité (non obligatoire si décharge ; max 2
  qualités, filières différentes) ; en dessous de 3, pas d'obligation de mix. Volume horaire course
  ≥60-70% du volume total (sauf décharge : réduit).
- Vélo : toujours endurance pure.
- Sorties longues en priorité le week-end. Jamais 2 séances intenses (RPE ≥6) à la suite ; jamais
  d'intensité au lendemain d'un renfo ou d'une sortie longue (repos ou RPE ≤4 ce jour-là) ; jamais de
  renfo la veille ou le lendemain d'une sortie longue.
- Répartis les jours de repos selon le nombre de séances (moins de séances → plus de repos, bien
  répartis, pas empilés). Séances doublées possibles si besoin (ex. muscu + vélo/footing le même jour).

Tu reçois en contexte : charge chronique, type de semaine, charge hebdo cible, nombre de séances par
sport, historique récent, contraintes en texte libre. Propose une répartition sur 7 jours
(lundi=1…dimanche=7) respectant tout ce qui précède.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni texte autour :
{
  "sessions": [
    { "sport": "Run" | "Ride" | "Strength", "template": string, "name": string, "dayOfWeek": 1-7,
      "durationMin": number, "reps": number }
  ],
  "rationale": string
}
"template" = nom EXACT d'une séance de la bibliothèque ci-dessus (Run/Ride ; omis pour la musculation) —
RAPPEL : jamais de séance hors bibliothèque. "durationMin" ajuste la durée (ou celle d'une séance de
musculation) ; "reps" ajuste le nombre d'intervalles d'une qualité (ignoré sinon). "name" = libellé
affiché. "rationale" doit LISTER pour chaque séance son jour et le nom EXACT de la séance utilisée (ex :
"Lundi : EF / Footing (Run) ; Mercredi : Tempo (Run) ; ...") suivi d'une courte justification — cela
permet de vérifier qu'aucune séance n'a été inventée hors bibliothèque.`;
}

/** Anthropic (Claude) — nécessite un compte payant / crédits. */
async function callAnthropic(system, userContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('Clé API Anthropic manquante (ANTHROPIC_API_KEY).');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: userContent }],
    },
    {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 45000,
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    const detail = typeof response.data === 'string' ? response.data.slice(0, 500) : JSON.stringify(response.data).slice(0, 500);
    throw new Error(`HTTP ${response.status} — ${detail}`);
  }
  const block = Array.isArray(response.data?.content) && response.data.content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Réponse IA vide ou invalide.');
  return block.text;
}

/** Récupère la liste des modèles disponibles pour la clé Groq fournie (utilisé en repli si le modèle configuré n'existe plus). */
async function fetchGroqModels(apiKey) {
  const res = await axios.get('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status >= 400 || !Array.isArray(res.data?.data)) return [];
  return res.data.data.map((m) => m.id).filter(Boolean);
}

/** Choisit un modèle de repli parmi ceux disponibles (préfère un gros modèle Llama "versatile"). */
function pickGroqFallbackModel(models) {
  return (
    models.find((id) => /llama-3\.\d+-70b/.test(id)) ||
    models.find((id) => /llama.*70b/i.test(id)) ||
    models.find((id) => /llama/i.test(id)) ||
    models[0] ||
    null
  );
}

/** Groq — API compatible OpenAI, gratuite (quotas généreux), aucune carte bancaire requise. */
async function callGroq(system, userContent) {
  const apiKey = process.env.GROQ_API_KEY || '';
  if (!apiKey) throw new Error('Clé API Groq manquante (GROQ_API_KEY). Clé gratuite sur https://console.groq.com/keys.');

  // useJsonMode force un JSON strict côté Groq ; certains modèles (ex: modèles "raisonneurs" gpt-oss)
  // échouent cette validation (json_validate_failed) — on retombe alors sur un prompt JSON classique,
  // notre propre parsePlanJson sachant déjà extraire l'objet JSON d'une réponse texte libre.
  // Les modèles "gpt-oss" (raisonneurs) peuvent aussi consommer tout le budget max_tokens en tokens de
  // raisonnement et ne jamais émettre de contenu (finish_reason "length", content vide) : reasoning_effort
  // "low" limite ce raisonnement pour laisser de la place à la vraie réponse.
  const requestBody = (model, useJsonMode) => ({
    model,
    temperature: 0.4,
    max_tokens: 3000,
    ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  });
  const post = (model, useJsonMode) =>
    axios.post('https://api.groq.com/openai/v1/chat/completions', requestBody(model, useJsonMode), {
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout: 45000,
      validateStatus: () => true,
    });

  let model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  let useJsonMode = true;
  let response = await post(model, useJsonMode);

  // Modèle inconnu/retiré : on retente une fois avec un modèle réellement disponible pour cette clé.
  if (response.status === 404 || response.data?.error?.code === 'model_not_found') {
    const models = await fetchGroqModels(apiKey);
    const fallback = pickGroqFallbackModel(models.filter((id) => id !== model));
    if (fallback) {
      model = fallback;
      response = await post(model, useJsonMode);
    }
  }

  // Le mode JSON strict n'est pas fiable sur tous les modèles : on retente sans, en s'appuyant sur le prompt.
  if (response.data?.error?.code === 'json_validate_failed') {
    useJsonMode = false;
    response = await post(model, useJsonMode);
  }

  if (response.status >= 400) {
    const detail = typeof response.data === 'string' ? response.data.slice(0, 500) : JSON.stringify(response.data).slice(0, 500);
    throw new Error(`HTTP ${response.status} — ${detail} (modèle testé : ${model}, réglable via GROQ_MODEL)`);
  }
  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse IA vide ou invalide.');
  return text;
}

/** Ollama — modèle local, 100% gratuit, nécessite `ollama serve` + un modèle installé (ex: `ollama pull llama3.1`). */
async function callOllama(system, userContent) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  let response;
  try {
    response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model: process.env.OLLAMA_MODEL || 'llama3.1',
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      },
      { timeout: 90000, validateStatus: () => true }
    );
  } catch (err) {
    throw new Error(`Ollama injoignable sur ${baseUrl} (lancer "ollama serve") : ${err.message}`);
  }

  if (response.status >= 400) {
    const detail = typeof response.data === 'string' ? response.data.slice(0, 500) : JSON.stringify(response.data).slice(0, 500);
    throw new Error(`HTTP ${response.status} — ${detail}`);
  }
  const text = response.data?.message?.content;
  if (!text) throw new Error('Réponse IA vide ou invalide.');
  return text;
}

/** Sélectionne le fournisseur IA selon AI_PROVIDER (anthropic par défaut, groq/ollama pour tester gratuitement). */
function callAiProvider(system, userContent) {
  if (PROVIDER === 'groq') return callGroq(system, userContent);
  if (PROVIDER === 'ollama') return callOllama(system, userContent);
  return callAnthropic(system, userContent);
}

/** Extrait un objet JSON d'une réponse texte, même si elle contient du texte ou des balises autour. */
function parsePlanJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch (_) {
        /* fallthrough */
      }
    }
    throw new Error('Réponse IA non conforme (JSON attendu).');
  }
}

/** Valide et normalise le plan renvoyé par l'IA vers un format exploitable côté client. */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** Construit une séance concrète à partir du choix de l'IA — une séance reprise telle quelle de la
 * bibliothèque Intervals.icu, ou une séance libre pour la musculation. */
function buildSessionFromAiChoice(s, workoutLibrary) {
  if (!s || !VALID_SPORTS.has(s.sport)) return null;
  const dayOfWeek = clamp(Math.round(Number(s.dayOfWeek) || 1), 1, 7);

  if (s.sport === 'Strength') {
    return {
      sport: 'Strength',
      name: String(s.name || 'Musculation').slice(0, 120),
      dayOfWeek,
      durationMin: clamp(Math.round(Number(s.durationMin) || 35), 15, 60),
      rpe: 7,
      description: '',
    };
  }

  const workout = (workoutLibrary || []).find((w) => sportForWorkoutType(w.type) === s.sport && w.name === s.template);
  if (!workout) return null; // séance hors bibliothèque : ignorée plutôt qu'inventée.

  // Durée ajustable pour toute séance (footing/sortie longue/qualité) ; nombre d'intervalles
  // ajustable seulement pour les qualités (bloc de répétition), échauffement/retour au calme suivent
  // proportionnellement via scaleDescriptionDuration.
  let description = workout.description || '';
  if (Number(s.reps) > 0 && hasRepeatBlock(description)) {
    description = setDescriptionReps(description, clamp(Math.round(Number(s.reps)), 1, 20));
  }
  if (Number(s.durationMin) > 0) {
    description = scaleDescriptionDuration(description, clamp(Math.round(Number(s.durationMin)), 10, 240));
  }

  const parsedDuration = parseDescriptionDurationMinutes(description);
  const fallbackDuration = workout.moving_time > 0 ? Math.round(workout.moving_time / 60) : 0;
  const durationMin = parsedDuration > 0 ? parsedDuration : fallbackDuration;

  return {
    sport: s.sport,
    // Nom toujours celui, exact, de la bibliothèque Intervals.icu — jamais celui (parfois
    // fantaisiste) proposé par l'IA, sinon une séance légitime peut avoir l'air d'une séance inventée.
    name: workout.name,
    dayOfWeek,
    durationMin,
    rpe: effectiveRpeForPlanned(workout.type, workout.name, workout.icu_rpe),
    description,
  };
}

const LONG_SESSION_NAMES = new Set(['Sortie longue']);

/** Filet de sécurité : si l'IA n'a pas respecté la consigne "pas de renfo la veille/le lendemain d'une
 * sortie longue", décale le renfo fautif vers un jour compatible plutôt que de compter sur le prompt seul. */
function enforceStrengthSpacing(sessions) {
  const longDays = sessions.filter((s) => LONG_SESSION_NAMES.has(s.name)).map((s) => s.dayOfWeek);
  if (!longDays.length) return sessions;

  const conflicts = (day) => longDays.some((d) => Math.abs(d - day) === 1);
  const usedDays = new Set(sessions.map((s) => s.dayOfWeek));

  for (const s of sessions) {
    if (s.sport !== 'Strength' || !conflicts(s.dayOfWeek)) continue;
    const candidates = [1, 2, 3, 4, 5, 6, 7].filter((d) => !conflicts(d) && !longDays.includes(d));
    const chosen = candidates.find((d) => !usedDays.has(d)) ?? candidates[0];
    if (chosen && chosen !== s.dayOfWeek) {
      usedDays.delete(s.dayOfWeek);
      s.dayOfWeek = chosen;
      usedDays.add(chosen);
    }
  }
  return sessions;
}

const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

/** Résumé déterministe (pas basé sur ce que l'IA prétend) des séances réellement retenues — sert de preuve
 * qu'aucune n'est hors bibliothèque, puisque buildSessionFromAiChoice ne laisse passer que des séances
 * réelles de la bibliothèque Intervals.icu (ou de la musculation libre). */
function summarizeSessions(sessions) {
  return sessions
    .slice()
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((s) => `${DAY_NAMES[s.dayOfWeek - 1]} : ${s.name} (${s.sport}, ${s.durationMin}min)`)
    .join(' ; ');
}

function normalizePlan(plan, workoutLibrary) {
  if (!plan || !Array.isArray(plan.sessions)) {
    throw new Error("Réponse IA non conforme (champ 'sessions' manquant).");
  }

  const sessions = plan.sessions.map((s) => buildSessionFromAiChoice(s, workoutLibrary)).filter(Boolean);

  if (!sessions.length) throw new Error("L'IA n'a proposé aucune séance exploitable.");

  enforceStrengthSpacing(sessions);

  const aiRationale = typeof plan.rationale === 'string' ? plan.rationale.trim() : '';
  const rationale = summarizeSessions(sessions) + '.' + (aiRationale ? ` ${aiRationale}` : '');

  return { sessions, rationale };
}

/** Demande à l'IA (Anthropic/Groq/Ollama selon AI_PROVIDER) de proposer une semaine cohérente (charge, ACWR, contraintes). */
async function generateAiWeekPlan({
  weekStart,
  planningType,
  nRun,
  nBike,
  nStrength,
  chronicLoad,
  targetAcwr,
  constraints,
  comment,
  recentWeeks,
  workoutLibrary,
}) {
  const context = {
    semaine_du: weekStart,
    type_semaine: planningType,
    objectif_acwr: targetAcwr,
    charge_chronique_4_semaines: Math.round(Number(chronicLoad) || 0),
    charge_hebdo_cible: Math.round((Number(chronicLoad) || 0) * (Number(targetAcwr) || 0)),
    nombre_seances_souhaite: { course_a_pied: nRun ?? 0, velo: nBike ?? 0, musculation: nStrength ?? 0 },
    contraintes_athlete: constraints && String(constraints).trim() ? String(constraints).trim() : 'Aucune contrainte particulière mentionnée.',
    commentaire_semaine: comment && String(comment).trim() ? String(comment).trim() : null,
    charges_hebdo_recentes: Array.isArray(recentWeeks) ? recentWeeks : [],
  };
  const userContent = `Propose la répartition des séances pour cette semaine, à partir du contexte suivant (JSON) :\n${JSON.stringify(context, null, 2)}`;

  const text = await callAiProvider(buildSystemPrompt(workoutLibrary), userContent);
  return normalizePlan(parsePlanJson(text), workoutLibrary);
}

module.exports = { generateAiWeekPlan };
