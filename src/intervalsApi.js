'use strict';

const axios = require('axios');

const INTERVALS_API_BASE = 'https://intervals.icu/api/v1';

/** Petit cache mémoire (ttl en ms) — équivalent de @st.cache_data(ttl=300). */
class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  key(parts) {
    return JSON.stringify(parts);
  }

  get(parts) {
    const k = this.key(parts);
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    return hit.value;
  }

  set(parts, value) {
    this.map.set(this.key(parts), { value, at: Date.now() });
  }

  /** Vide tout le cache — appelé après une écriture pour éviter de resservir des données obsolètes. */
  clear() {
    this.map.clear();
  }
}

const cache = new TtlCache(5 * 60 * 1000); // 5 minutes, comme le dashboard Streamlit

/** Appel authentifié à l'API Intervals.icu avec une clé API personnelle. */
async function intervalsApiRequest(method, path, apiKey, { params, data, timeout = 30000 } = {}) {
  if (!apiKey) {
    throw new Error('Clé API Intervals.icu manquante.');
  }

  const url = `${INTERVALS_API_BASE}${path}`;

  try {
    const response = await axios.request({
      method,
      url,
      params,
      data,
      timeout,
      auth: { username: 'API_KEY', password: apiKey },
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      const detail =
        typeof response.data === 'string'
          ? response.data.slice(0, 1000)
          : JSON.stringify(response.data).slice(0, 1000);
      throw new Error(`HTTP ${response.status} — ${detail}`);
    }

    return response.data ?? null;
  } catch (err) {
    if (err.response) {
      throw new Error(`HTTP ${err.response.status} — ${JSON.stringify(err.response.data).slice(0, 1000)}`);
    }
    throw err;
  }
}

/** Récupère la liste des athlètes accessibles (soi-même + athlètes coachés). */
async function fetchAthleteSummary(apiKey) {
  const cacheKey = ['athlete-summary', apiKey];
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await intervalsApiRequest('GET', '/athlete/0/athlete-summary.json', apiKey);
  cache.set(cacheKey, result);
  return result;
}

/** Récupère les activités réalisées sur une période. */
async function fetchIntervalsEvents(apiKey, oldest, newest, athleteId = '0') {
  const cacheKey = ['activities', apiKey, oldest, newest, athleteId];
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await intervalsApiRequest('GET', `/athlete/${athleteId}/activities`, apiKey, {
    params: { oldest, newest },
  });
  cache.set(cacheKey, result);
  return result;
}

/** Récupère les événements du calendrier (planifié + réalisé) sur une période. */
async function fetchCalendarEvents(apiKey, oldest, newest, athleteId = '0') {
  const cacheKey = ['events', apiKey, oldest, newest, athleteId];
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await intervalsApiRequest('GET', `/athlete/${athleteId}/events`, apiKey, {
    params: { oldest, newest },
  });
  cache.set(cacheKey, result);
  return result;
}

/** Upsert d'un lot de séances planifiées dans Intervals.icu. */
async function createOrUpdateCalendarEvents(apiKey, events, athleteId = '0') {
  if (!events || !events.length) return [];
  const result = await intervalsApiRequest('POST', `/athlete/${athleteId}/events/bulk`, apiKey, {
    params: { upsert: 'true' },
    data: events,
  });
  cache.clear();
  return result;
}

/** Met à jour un événement du calendrier existant (par id Intervals.icu) — utilisé pour la modification d'une séance déjà envoyée. */
async function updateCalendarEvent(apiKey, athleteId, eventId, patch) {
  const result = await intervalsApiRequest('PUT', `/athlete/${athleteId}/events/${eventId}`, apiKey, {
    data: patch,
  });
  cache.clear();
  return result;
}

/** Supprime un événement du calendrier existant (par id Intervals.icu). */
async function deleteCalendarEvent(apiKey, athleteId, eventId) {
  const result = await intervalsApiRequest('DELETE', `/athlete/${athleteId}/events/${eventId}`, apiKey);
  cache.clear();
  return result;
}

/** Récupère la bibliothèque de séances enregistrée dans Intervals.icu. */
async function fetchWorkoutLibrary(apiKey, athleteId = '0') {
  const cacheKey = ['workouts', apiKey, athleteId];
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await intervalsApiRequest('GET', `/athlete/${athleteId}/workouts`, apiKey);
  const workouts = Array.isArray(result) ? result : [];
  cache.set(cacheKey, workouts);
  return workouts;
}

/** Récupère l'arborescence des dossiers de la bibliothèque de séances Intervals.icu. */
async function fetchWorkoutFolders(apiKey, athleteId = '0') {
  const cacheKey = ['workout-folders', apiKey, athleteId];
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await intervalsApiRequest('GET', `/athlete/${athleteId}/folders`, apiKey);
  const folders = Array.isArray(result) ? result : [];
  cache.set(cacheKey, folders);
  return folders;
}

module.exports = {
  intervalsApiRequest,
  fetchAthleteSummary,
  fetchIntervalsEvents,
  fetchCalendarEvents,
  createOrUpdateCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
  fetchWorkoutFolders,
  fetchWorkoutLibrary,
};
