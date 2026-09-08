'use strict';

const { fetchAthleteSummary } = require('./intervalsApi');

/**
 * Retourne la liste des athlètes accessibles : {id: label}.
 * Toujours au moins {"0": "Moi (compte principal)"}.
 */
async function getAthleteOptions(apiKey) {
  const options = [{ id: '0', label: 'Moi (compte principal)' }];

  let summary = null;
  try {
    summary = await fetchAthleteSummary(apiKey);
  } catch (e) {
    summary = null;
  }

  if (Array.isArray(summary)) {
    const seen = new Set(options.map((o) => o.id));
    for (const a of summary) {
      const aid = String(a.id ?? a.athlete_id ?? a.athleteId ?? '').trim();
      const aname = a.name ?? a.athlete_name ?? a.full_name ?? aid;
      if (aid && !seen.has(aid)) {
        seen.add(aid);
        options.push({ id: aid, label: String(aname) });
      }
    }
  }

  return options;
}

module.exports = { getAthleteOptions };
