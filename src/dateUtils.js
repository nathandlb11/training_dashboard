'use strict';

/** Extrait la partie date (YYYY-MM-DD) d'une chaîne ISO datetime, sans conversion de fuseau. */
function dateOnly(str) {
  if (!str) return null;
  return String(str).slice(0, 10);
}

function isoToUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcDateToIso(date) {
  return date.toISOString().slice(0, 10);
}

/** Ajoute n jours (peut être négatif) à une date ISO. */
function addDaysIso(iso, n) {
  const d = isoToUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDateToIso(d);
}

/** Lundi de la semaine ISO contenant la date donnée (semaine lundi -> dimanche). */
function weekStartMonday(iso) {
  const d = isoToUtcDate(iso);
  const day = d.getUTCDay(); // 0 = dimanche .. 6 = samedi
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return utcDateToIso(d);
}

/** Liste de dates ISO inclusives entre start et end. */
function dateRangeIso(startIso, endIso) {
  const out = [];
  let cur = startIso;
  while (cur <= endIso) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

function todayIso() {
  return utcDateToIso(new Date());
}

function compareIso(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = {
  dateOnly,
  isoToUtcDate,
  utcDateToIso,
  addDaysIso,
  weekStartMonday,
  dateRangeIso,
  todayIso,
  compareIso,
};
