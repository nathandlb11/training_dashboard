'use strict';

/** Échappe une valeur pour un champ CSV (quote si elle contient une virgule, un guillemet ou un retour à la ligne). */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Construit un CSV (séparateur virgule, fin de ligne CRLF) à partir d'une liste de colonnes
 * ({header, key} ou {header, value: row => ...}) et de lignes de données.
 */
function rowsToCsv(columns, rows) {
  const header = columns.map((c) => escapeCsvField(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvField(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(',')
  );
  return [header, ...lines].join('\r\n');
}

module.exports = { rowsToCsv };
