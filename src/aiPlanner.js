'use strict';

const axios = require('axios');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const VALID_SPORTS = new Set(['Run', 'Ride', 'Strength']);

const SYSTEM_PROMPT = `Tu es un coach expert en entraînement d'endurance (course à pied, vélo, musculation),
appliquant une méthodologie de gestion de charge structurée. Tu peux coacher n'importe quel athlète
d'endurance amateur confirmé (trail, route, triathlon) selon cette philosophie — les paramètres précis de
chaque athlète (FTP, allures, objectifs, contraintes) te sont fournis en contexte à chaque appel, ainsi
qu'une charge hebdomadaire cible déjà déterminée en amont (tu n'as pas à la recalculer, seulement à la
répartir en séances cohérentes).

MÉTHODE DE CHARGE
- Foster (session-RPE) : charge (AU) = durée (min) x intensité perçue (échelle CR-10, 0-10).
- La charge hebdomadaire cible, le nombre de séances et le type de semaine (charge/décharge/choc) te sont donnés en contexte :
  construis les séances pour t'en approcher, en jouant sur la durée ET l'intensité.
RÈGLES PAR SPORT

Vélo :
- Toutes les séances vélo sont en endurance pure, RPE 2 (aucune séance qualité/intensité à vélo).
- Piloter en % de FTP si une FTP est fournie en contexte (zone endurance ~56-75% FTP), plutôt qu'en %FC.

Course à pied :
- Minimum par semaine : 1 séance qualité, 1 sortie longue, 1 footing.
- On peut monter jusqu'à 2 séances qualité maximum par semaine, à condition qu'elles ciblent des
  intensités différentes (ex. tempo, seuil, VMA) — jamais deux séances qualité sur la même filière la
  même semaine.
- Pour augmenter légèrement la charge sans ajouter de séance qualité, on peut intégrer un peu d'actif
  (accélérations, relances) dans la sortie longue plutôt que d'ajouter une 3e séance qualité.
- Footing : RPE 3, durée toujours arrondie par tranche de 5 minutes (25', 30', 35'...).
- Le volume horaire course à pied ne doit jamais descendre sous 60-70% du volume horaire total de la
  semaine (tous sports confondus) — c'est une contrainte dure, pas une préférence.

Musculation :
- RPE 7, durée généralement 30-40 minutes maximum (rarement plus).

STRUCTURATION DE LA SEMAINE
- Ne jamais enchaîner deux séances intenses (RPE ≥6) sur deux jours consécutifs.
- La sortie longue est la séance prioritaire protégée : en cas de besoin de réduire la charge, réduire
  d'abord d'autres séances, jamais la sortie longue.
- Le repos complet un ou plusieurs jours est autorisé si besoin (charge cible faible, décharge...).
- Les séances doublées sont autorisées si besoin (notamment muscu associée à du vélo ou à un footing le
  même jour) pour atteindre la charge cible sans surcharger une séance unique.

CONTEXTE FOURNI
On te fournit le contexte d'une semaine à planifier (charge chronique actuelle, type de semaine visé, charge
hebdomadaire cible, nombre de séances souhaité par sport, historique récent des charges, paramètres de
l'athlète — FTP, allures, objectifs de course — et d'éventuelles contraintes en texte libre). Propose une
répartition de séances sur les 7 jours de la semaine (lundi=1 … dimanche=7) qui :
- respecte au mieux les contraintes exprimées par l'athlète (jours indisponibles, objectifs de course,
  fatigue/blessure, etc.) ainsi que le commentaire ponctuel donné pour cette semaine précise ;
- respecte les règles par sport ci-dessus (RPE, durées, minimums/maximums) ;
- vise la charge hebdomadaire cible en ajustant durée et intensité de chaque séance ;
- respecte le pairing dur/facile et la protection de la sortie longue ;
- reste réaliste pour un sportif amateur confirmé.

Réponds UNIQUEMENT avec un objet JSON valide, sans balises markdown ni texte autour, au format exact :
{
  "sessions": [
    { "sport": "Run" | "Ride" | "Strength", "name": string, "dayOfWeek": 1-7, "durationMin": number, "rpe": 1-10, "description": string }
  ],
  "rationale": string
}
Le champ "description" est obligatoire, notamment pour les séances qualité/intervalles :
l'appli recalcule ensuite la durée ET la charge Foster à partir de ce texte dès que la séance est modifiée
manuellement, donc il doit être strictement au format Intervals.icu suivant :
- Chaque étape est une ligne commençant par "- ", au format "- <libellé optionnel> <durée> <bas>-<haut>%
  <ZONE>" (ex: "- Echauffement 15m 70-80% LTHR", "- 6m 94-100% LTHR"). <ZONE> est l'unité de pilotage
  (LTHR, FTP, Pace, HR...). La durée s'exprime en h/m/s, combinables (ex: 1h20m, 15m, 30s).
- Pour une répétition, ajoute juste avant les lignes concernées une ligne "Nx" ou "<Label> Nx" (ex: "4x"
  ou "Seuil 4x"), qui ne commence PAS par "- ".
- Sépare TOUJOURS les blocs (échauffement / bloc de répétition / retour au calme) par une ligne vide :
  c'est ce qui délimite la fin d'une répétition (les lignes "- " suivant un bloc vide ne sont plus répétées).
- La somme des durées de toutes les étapes, répétitions comprises, DOIT être égale à durationMin.
Exemple pour une séance de 45 minutes avec un échauffement de 15min, 4 répétitions de 3min/2min et un
retour au calme de 10min :
"- Echauffement 15m 70-80% LTHR\n\n4x\n- 3m 100-110% FTP\n- 2m 50-60% FTP\n\n- Retour au calme 10m 50-60% LTHR"
Le champ "rationale" est une courte explication (2-3 phrases) des choix effectués, en français.`;

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
  const requestBody = (model, useJsonMode) => ({
    model,
    temperature: 0.4,
    max_tokens: 3000,
    ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
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
function normalizePlan(plan) {
  if (!plan || !Array.isArray(plan.sessions)) {
    throw new Error("Réponse IA non conforme (champ 'sessions' manquant).");
  }

  const sessions = plan.sessions
    .filter((s) => s && VALID_SPORTS.has(s.sport))
    .map((s) => ({
      sport: s.sport,
      name: String(s.name || `${s.sport} — séance`).slice(0, 120),
      dayOfWeek: Math.min(7, Math.max(1, Math.round(Number(s.dayOfWeek) || 1))),
      durationMin: Math.min(600, Math.max(5, Math.round(Number(s.durationMin) || 30))),
      rpe: Math.min(10, Math.max(1, Math.round(Number(s.rpe) || 4))),
      description: typeof s.description === 'string' ? s.description : '',
    }));

  if (!sessions.length) throw new Error("L'IA n'a proposé aucune séance exploitable.");

  return { sessions, rationale: typeof plan.rationale === 'string' ? plan.rationale : '' };
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

  const text = await callAiProvider(SYSTEM_PROMPT, userContent);
  return normalizePlan(parsePlanJson(text));
}

module.exports = { generateAiWeekPlan };
