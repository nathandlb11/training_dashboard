// Widget iPhone Semaine — Scriptable
//
// Affiche :
// - Lundi -> Dimanche
// - Séances planifiées / réalisées fusionnées
// - Charge réalisée / charge planifiée
// - Double barre : réalisé vs planifié à date
// - Colonnes légèrement plus larges
//
// BARRES :
// - Vert  = charge réellement réalisée sur la semaine
// - Orange = charge planifiée cumulée jusqu'à aujourd'hui
//
// =========================================================
// CONFIGURATION
// =========================================================
const BASE_URL =
 "https://training-dashboard-intervals-icu-ten.vercel.app/";
const ATHLETE_ID =
 "i661521";
const TOKEN =
 "azhTgjfP0gT";
// =========================================================
// API
// =========================================================
async function fetchDashboardData() {
 const base =
   BASE_URL.replace(/\/+$/, '');
 const url =
   `${base}/api/dashboard-data` +
   `?athleteId=${encodeURIComponent(ATHLETE_ID)}` +
   `&forecastWeeks=1` +
   `${TOKEN
     ? `&token=${encodeURIComponent(TOKEN)}`
     : ''}`;
 const req =
   new Request(url);
 const data =
   await req.loadJSON();
 if (data.error) {
   throw new Error(data.error);
 }
 return data;
}
// =========================================================
// DATES
// =========================================================
const DAY_ABBR = [
 "Lun",
 "Mar",
 "Mer",
 "Jeu",
 "Ven",
 "Sam",
 "Dim"
];
function localISODate(
 date = new Date()
) {
 const y =
   date.getFullYear();
 const m =
   String(
     date.getMonth() + 1
   ).padStart(2, '0');
 const d =
   String(
     date.getDate()
   ).padStart(2, '0');
 return `${y}-${m}-${d}`;
}
function getMondayISO(
 date = new Date()
) {
 const d =
   new Date(
     date.getFullYear(),
     date.getMonth(),
     date.getDate()
   );
 const day =
   d.getDay();
 const diff =
   day === 0
     ? -6
     : 1 - day;
 d.setDate(
   d.getDate() + diff
 );
 return localISODate(d);
}
function addDaysISO(
 iso,
 days
) {
 const [
   y,
   m,
   d
 ] =
   iso
     .split('-')
     .map(Number);
 const date =
   new Date(
     y,
     m - 1,
     d
   );
 date.setDate(
   date.getDate() + days
 );
 return localISODate(date);
}
function dayAbbrFr(iso) {
 const [
   y,
   m,
   d
 ] =
   iso
     .split('-')
     .map(Number);
 const date =
   new Date(
     y,
     m - 1,
     d
   );
 const jsDay =
   date.getDay();
 const idx =
   jsDay === 0
     ? 6
     : jsDay - 1;
 return DAY_ABBR[idx];
}
function formatDayFr(iso) {
 const [
   ,
   m,
   d
 ] =
   iso.split('-');
 return `${d}/${m}`;
}
// =========================================================
// SPORTS
// =========================================================
const SPORT_TYPE_MAP = {
 WeightTraining:
   'Strength',
 TrailRun:
   'Run',
 VirtualRide:
   'Ride',
 GravelRide:
   'Ride',
 MountainBikeRide:
   'Ride',
 OpenWaterSwim:
   'Swim'
};
const SPORT_ICONS = {
 Run:
   "\uD83C\uDFC3",
 Ride:
   "\uD83D\uDEB4",
 Swim:
   "\uD83C\uDFCA",
 Strength:
   "\uD83D\uDCAA",
 Hike:
   "\uD83E\uDD7E",
 Walk:
   "\uD83D\uDEB6"
};
function sportIcon(type) {
 const t =
   SPORT_TYPE_MAP[type] ||
   type;
 return (
   SPORT_ICONS[t] ||
   "\uD83C\uDFBD"
 );
}
// =========================================================
// DÉTECTION SÉANCE RÉALISÉE
// =========================================================
function isCompletedSession(s) {
 if (s.done === true) {
   return true;
 }
 if (s.completed === true) {
   return true;
 }
 if (s.isCompleted === true) {
   return true;
 }
 if (
   s.status === 'done' ||
   s.status === 'completed'
 ) {
   return true;
 }
 return false;
}
// =========================================================
// IDENTIFICATION DU SPORT
// =========================================================
function normalizedType(s) {
 return (
   s.type ||
   s.activityType ||
   s.sport ||
   s.plannedType ||
   ''
 );
}
// =========================================================
// FUSION DES SÉANCES
// =========================================================
function mergeSessions(
 sessions
) {
 const result =
   new Map();
 for (
   const s of sessions
 ) {
   if (!s.date) {
     continue;
   }
   const name =
     (
       s.name ||
       s.title ||
       normalizedType(s) ||
       ''
     )
       .toString()
       .trim()
       .toLowerCase();
   const type =
     normalizedType(s)
       .toString()
       .trim()
       .toLowerCase();
   const explicitId =
     s.plannedId ||
     s.planId ||
     s.activityId ||
     s.workoutId ||
     null;
   let key;
   if (explicitId) {
     key =
       `id:${explicitId}`;
   } else {
     key =
       `${s.date}|${name}|${type}`;
   }
   if (!result.has(key)) {
     result.set(
       key,
       {
         ...s
       }
     );
     continue;
   }
   const existing =
     result.get(key);
   const currentDone =
     isCompletedSession(s);
   const existingDone =
     isCompletedSession(
       existing
     );
   if (
     currentDone &&
     !existingDone
   ) {
     result.set(
       key,
       {
         ...existing,
         ...s,
         done: true
       }
     );
   } else if (
     currentDone &&
     existingDone
   ) {
     result.set(
       key,
       {
         ...existing,
         ...s,
         done: true
       }
     );
   }
 }
 return [
   ...result.values()
 ];
}
// =========================================================
// FUSION PLUS AGRESSIVE PAR JOUR
// =========================================================
function mergePlannedAndCompleted(
 sessions
) {
 const completed =
   sessions.filter(
     isCompletedSession
   );
 const planned =
   sessions.filter(
     s =>
       !isCompletedSession(s)
   );
 const usedCompleted =
   new Set();
 const result = [];
 for (
   const p of planned
 ) {
   let matchIndex = -1;
   // 1. Même jour + même nom
   for (
     let i = 0;
     i < completed.length;
     i++
   ) {
     if (
       usedCompleted.has(i)
     ) {
       continue;
     }
     const c =
       completed[i];
     if (
       c.date === p.date &&
       (
         (
           c.name &&
           p.name &&
           c.name === p.name
         ) ||
         (
           c.title &&
           p.title &&
           c.title === p.title
         )
       )
     ) {
       matchIndex = i;
       break;
     }
   }
   // 2. Même jour + type similaire
   if (
     matchIndex === -1
   ) {
     for (
       let i = 0;
       i < completed.length;
       i++
     ) {
       if (
         usedCompleted.has(i)
       ) {
         continue;
       }
       const c =
         completed[i];
       if (
         c.date === p.date &&
         normalizedType(c) ===
         normalizedType(p)
       ) {
         matchIndex = i;
         break;
       }
     }
   }
   // 3. Même jour + une seule séance réalisée
   if (
     matchIndex === -1
   ) {
     const candidates =
       completed
         .map(
           (c, i) => ({
             c,
             i
           })
         )
         .filter(
           ({ c, i }) =>
             c.date === p.date &&
             !usedCompleted.has(i)
         );
     if (
       candidates.length === 1
     ) {
       matchIndex =
         candidates[0].i;
     }
   }
   if (
     matchIndex !== -1
   ) {
     const c =
       completed[
         matchIndex
       ];
     usedCompleted.add(
       matchIndex
     );
     result.push({
       ...p,
       ...c,
       done: true,
       plannedTime:
         p.plannedTime ??
         c.plannedTime,
       plannedLoad:
         p.plannedLoad ??
         c.plannedLoad,
       realTime:
         c.realTime ??
         c.duration ??
         p.realTime,
       realLoad:
         c.realLoad ??
         c.load ??
         p.realLoad
     });
   } else {
     result.push(p);
   }
 }
 completed.forEach(
   (c, i) => {
     if (
       !usedCompleted.has(i)
     ) {
       result.push(c);
     }
   }
 );
 return result;
}
// =========================================================
// STATUT
// =========================================================
function getSessionStatus(
 session
) {
 if (
   isCompletedSession(
     session
   )
 ) {
   return 'done';
 }
 if (
   session.status
 ) {
   return session.status;
 }
 return 'planned';
}
function statusStyle(
 status
) {
 switch (status) {
   case 'done':
     return {
       icon: "✓",
       color:
         new Color(
           "#35c46f"
         )
     };
   case 'extra':
     return {
       icon: "+",
       color:
         new Color(
           "#4a90d9"
         )
     };
   case 'missed':
     return {
       icon: "✕",
       color:
         new Color(
           "#ef5757"
         )
     };
   case 'today':
     return {
       icon: "●",
       color:
         new Color(
           "#f5a623"
         )
     };
   default:
     return {
       icon: "○",
       color:
         new Color(
           "#5a6480"
         )
     };
 }
}
function statusColorHex(
 status
) {
 switch (status) {
   case 'done':
   case 'extra':
     return "#35c46f";
   case 'missed':
     return "#ef5757";
   case 'today':
     return "#f5a623";
   default:
     return "#5a6480";
 }
}
// =========================================================
// DURÉE
// =========================================================
function shortDuration(t) {
 if (!t) {
   return '';
 }
 return t
   .replace(' ', '')
   .replace('min', "'");
}
// =========================================================
// GROUPEMENT PAR JOUR
// =========================================================
function groupByDay(
 sessions,
 weekStart
) {
 const byDate =
   new Map();
 for (
   let i = 0;
   i < 7;
   i++
 ) {
   const iso =
     addDaysISO(
       weekStart,
       i
     );
   byDate.set(
     iso,
     []
   );
 }
 for (
   const s of sessions
 ) {
   if (
     byDate.has(s.date)
   ) {
     byDate
       .get(s.date)
       .push(s);
   }
 }
 return [
   ...byDate.entries()
 ];
}
// =========================================================
// BARRE DE PROGRESSION
// =========================================================
//
// Barre simple avec remplissage depuis la gauche.
//
// ratio = valeur / valeurMax
//
// =========================================================
function addProgressBar(
 w,
 value,
 maxValue,
 width,
 height,
 colorHex
) {
 const ratio =
   maxValue > 0
     ? Math.max(
         0,
         Math.min(
           1,
           value /
             maxValue
         )
       )
     : 0;
 const container =
   w.addStack();
 container
   .layoutHorizontally();
 container.addSpacer();
 const bar =
   container.addStack();
 bar.size =
   new Size(
     width,
     height
   );
 bar.backgroundColor =
   new Color(
     "#2a3142"
   );
 bar.cornerRadius =
   height / 2;
 bar.layoutHorizontally();
 const fillWidth =
   width * ratio;
 if (
   fillWidth > 0
 ) {
   const fill =
     bar.addStack();
   fill.size =
     new Size(
       fillWidth,
       height
     );
   fill.backgroundColor =
     new Color(
       colorHex
     );
   fill.cornerRadius =
     height / 2;
 }
 bar.addSpacer();
 container.addSpacer();
}
// =========================================================
// DOUBLE BARRE
// =========================================================
//
// Ligne 1 : réalisé
// Ligne 2 : planifié à date
//
// La deuxième barre utilise exactement la couleur
// des séances du jour non réalisées : #f5a623.
//
// =========================================================
function addDoubleProgressBars(
 w,
 realLoad,
 plannedTotal,
 plannedToDate,
 width,
 height
) {
 // -------------------------------------------------------
 // Barre réalisée
 // -------------------------------------------------------
 addProgressBar(
   w,
   realLoad,
   plannedTotal,
   width,
   height,
   "#35c46f"
 );
 // Petit espace entre les deux barres
 w.addSpacer(2);
 // -------------------------------------------------------
 // Barre planifiée à date
 // -------------------------------------------------------
 addProgressBar(
   w,
   plannedToDate,
   plannedTotal,
   width,
   height,
   "#f5a623"
 );
}
// =========================================================
// CALCUL DE LA CHARGE PLANIFIÉE À DATE
// =========================================================
//
// On additionne les charges planifiées des séances
// jusqu'à aujourd'hui inclus.
//
// Cela permet de comparer :
//
//   charge réellement réalisée
//             VS
//   charge qui aurait dû être réalisée à ce stade
//
// IMPORTANT :
// Les séances futures ne sont pas comptées dans
// plannedToDate.
//
// =========================================================
function calculatePlannedToDate(
 sessions,
 today
) {
 let total = 0;
 for (
   const s of sessions
 ) {
   if (
     !s.date ||
     s.date > today
   ) {
     continue;
   }
   const load =
     Number(
       s.plannedLoad
     );
   if (
     Number.isFinite(load)
   ) {
     total += load;
   }
 }
 return total;
}
// =========================================================
// COLONNES SEMAINE
// =========================================================
function addWeekColumns(
 w,
 days,
 today,
 width
) {
 const gap = 6;
 const colWidth =
   (
     width -
     gap * 6
   ) / 7;
 const row =
   w.addStack();
 row.layoutHorizontally();
 row.spacing =
   gap;
 row.centerAlignContent();
 row.addSpacer();
 days.forEach(
   ([date, sessions]) => {
     const col =
       row.addStack();
     col.layoutVertically();
     col.size =
       new Size(
         colWidth,
         0
       );
     col.centerAlignContent();
     // ---------------------------------------------------
     // Jour
     // ---------------------------------------------------
     const dayLabel =
       col.addText(
         dayAbbrFr(date)
       );
     dayLabel.font =
       Font.semiboldSystemFont(
         8.5
       );
     dayLabel.textColor =
       date === today
         ? new Color(
             "#f5a623"
           )
         : new Color(
             "#9aa7c2"
           );
     dayLabel.centerAlignText();
     col.addSpacer(3);
     // ---------------------------------------------------
     // Repos
     // ---------------------------------------------------
     if (
       !sessions.length
     ) {
       const rest =
         col.addText(
           "–"
         );
       rest.font =
         Font.systemFont(
           11
         );
       rest.textColor =
         new Color(
           "#4a5068"
         );
       rest.centerAlignText();
       return;
     }
     // ---------------------------------------------------
     // Séances
     // ---------------------------------------------------
     sessions.forEach(
       (s, i) => {
         if (
           i > 0
         ) {
           col.addSpacer(
             4
           );
         }
         const status =
           getSessionStatus(
             s
           );
         const badge =
           col.addStack();
         badge.size =
           new Size(
             21,
             21
           );
         badge.backgroundColor =
           new Color(
             statusColorHex(
               status
             )
           );
         badge.cornerRadius =
           10.5;
         badge.centerAlignContent();
         const icon =
           badge.addText(
             sportIcon(
               normalizedType(s)
             )
           );
         icon.font =
           Font.systemFont(
             11.5
           );
         icon.centerAlignText();
         // ------------------------------------------------
         // Durée + charge
         // ------------------------------------------------
         const time =
           s.done
             ? (
                 s.realTime ??
                 s.actualTime
               )
             : s.plannedTime;
         const load =
           s.done
             ? (
                 s.realLoad ??
                 s.actualLoad
               )
             : s.plannedLoad;
         const info =
           [
             shortDuration(
               time
             ),
             load != null
               ? `${load}`
               : null
           ]
             .filter(Boolean)
             .join(
               ' · '
             );
         if (
           info
         ) {
           col.addSpacer(
             1
           );
           const infoText =
             col.addText(
               info
             );
           infoText.font =
             Font.systemFont(
               7.5
             );
           infoText.textColor =
             new Color(
               "#8b96b3"
             );
           infoText.centerAlignText();
           infoText.minimumScaleFactor =
             0.6;
         }
       }
     );
   }
 );
 row.addSpacer();
}
// =========================================================
// LIGNE POUR SMALL / LARGE
// =========================================================
function addSessionRow(
 w,
 session,
 showName
) {
 const row =
   w.addStack();
 row.centerAlignContent();
 row.spacing =
   6;
 const status =
   getSessionStatus(
     session
   );
 const style =
   statusStyle(
     status
   );
 const dayText =
   row.addText(
     dayAbbrFr(
       session.date
     )
   );
 dayText.font =
   Font.mediumSystemFont(
     11
   );
 dayText.textColor =
   new Color(
     "#9aa7c2"
   );
 const icon =
   row.addText(
     style.icon
   );
 icon.font =
   Font.boldSystemFont(
     11
   );
 icon.textColor =
   style.color;
 if (
   showName
 ) {
   const name =
     row.addText(
       session.name ||
       session.type ||
       'Séance'
     );
   name.font =
     Font.systemFont(
       11
     );
   name.textColor =
     Color.white();
   name.lineLimit =
     1;
   row.addSpacer();
 } else {
   row.addSpacer();
 }
 const load =
   session.done
     ? session.realLoad
     : session.plannedLoad;
 const loadText =
   row.addText(
     load != null
       ? `${load}`
       : "—"
   );
 loadText.font =
   Font.systemFont(
     11
   );
 loadText.textColor =
   new Color(
     "#6b7690"
   );
}
// =========================================================
// CRÉATION DU WIDGET
// =========================================================
async function createWidget() {
 const w =
   new ListWidget();
 w.backgroundColor =
   new Color(
     "#151a24"
   );
 w.setPadding(
   10,
   12,
   10,
   12
 );
 try {
   // -----------------------------------------------------
   // API
   // -----------------------------------------------------
   const data =
     await fetchDashboardData();
   const cw =
     data.currentWeekSessions;
   const family =
     config.widgetFamily ||
     'medium';
   if (
     !cw ||
     !cw.sessions
   ) {
     const empty =
       w.addText(
         "Aucune séance cette semaine."
       );
     empty.font =
       Font.systemFont(
         13
       );
     empty.textColor =
       Color.gray();
     return w;
   }
   // -----------------------------------------------------
   // DATES
   // -----------------------------------------------------
   const now =
     new Date();
   const today =
     localISODate(
       now
     );
   const weekStart =
     getMondayISO(
       now
     );
   // -----------------------------------------------------
   // FUSION DES SÉANCES
   // -----------------------------------------------------
   let sessions =
     mergeSessions(
       cw.sessions
     );
   sessions =
     mergePlannedAndCompleted(
       sessions
     );
   // -----------------------------------------------------
   // JOURS
   // -----------------------------------------------------
   const days =
     groupByDay(
       sessions,
       weekStart
     );
   // -----------------------------------------------------
   // CHARGES
   // -----------------------------------------------------
   const totals =
     cw.totals;
   const plannedLoad =
     Number(
       totals.plannedLoad
     ) || 0;
   const realLoad =
     Number(
       totals.realLoad
     ) || 0;
   // -----------------------------------------------------
   // CHARGE PLANIFIÉE À DATE
   // -----------------------------------------------------
   //
   // Toutes les séances planifiées jusqu'à aujourd'hui
   // inclus sont additionnées.
   //
   // Les séances réalisées fusionnées conservent leur
   // plannedLoad grâce au merge précédent.
   //
   const plannedToDate =
     calculatePlannedToDate(
       sessions,
       today
     );
   // -----------------------------------------------------
   // ÉCART À DATE
   // -----------------------------------------------------
   const loadGap =
     realLoad -
     plannedToDate;
   // -----------------------------------------------------
   // RATIO GLOBAL
   // -----------------------------------------------------
   const ratio =
     plannedLoad > 0
       ? realLoad /
         plannedLoad
       : 0;
   // -----------------------------------------------------
   // HEADER
   // -----------------------------------------------------
   const header =
     w.addStack();
   header.centerAlignContent();
   const title =
     header.addText(
       "Planning"
     );
   title.font =
     Font.semiboldSystemFont(
       13
     );
   title.textColor =
     new Color(
       "#9aa7c2"
     );
   header.addSpacer();
   const count =
     header.addText(
       `${totals.doneCount}/${totals.plannedCount}`
     );
   count.font =
     Font.boldSystemFont(
       family === 'small'
         ? 16
         : 20
     );
   count.textColor =
     ratio >= 1
       ? new Color(
           "#35c46f"
         )
       : new Color(
           "#f5a623"
         );
   // -----------------------------------------------------
   // CHARGE
   // -----------------------------------------------------
   w.addSpacer(4);
   const loadRow =
     w.addStack();
   loadRow.centerAlignContent();
   const loadCaption =
     loadRow.addText(
       `Charge : ${realLoad} / ${plannedLoad}`
     );
   loadCaption.font =
     Font.systemFont(
       9
     );
   loadCaption.textColor =
     new Color(
       "#6b7690"
     );
   loadRow.addSpacer();
   // -----------------------------------------------------
   // INDICATEUR AVANCE / RETARD
   // -----------------------------------------------------
   const gapText =
     loadGap >= 0
       ? `+${Math.round(loadGap)}`
       : `${Math.round(loadGap)}`;
   const gapLabel =
     loadRow.addText(
       gapText
     );
   gapLabel.font =
     Font.boldSystemFont(
       9
     );
   gapLabel.textColor =
     loadGap >= 0
       ? new Color(
           "#35c46f"
         )
       : new Color(
           "#f5a623"
         );
   // -----------------------------------------------------
   // DOUBLE BARRE
   // -----------------------------------------------------
   w.addSpacer(2);
   addDoubleProgressBars(
     w,
     realLoad,
     plannedLoad,
     plannedToDate,
     family === 'small'
       ? 126
       : 284,
     7
   );
   // -----------------------------------------------------
   // SMALL
   // -----------------------------------------------------
   if (
     family === 'small'
   ) {
     w.addSpacer(7);
     const todaySessions =
       sessions.filter(
         s =>
           s.date === today
       );
     if (
       !todaySessions.length
     ) {
       const rest =
         w.addText(
           "Repos aujourd'hui"
         );
       rest.font =
         Font.systemFont(
           11
         );
       rest.textColor =
         new Color(
           "#6b7690"
         );
     } else {
       todaySessions.forEach(
         s =>
           addSessionRow(
             w,
             s,
             true
           )
       );
     }
   // -----------------------------------------------------
   // MEDIUM
   // -----------------------------------------------------
   } else if (
     family === 'medium'
   ) {
     w.addSpacer(5);
     const weekContainer =
       w.addStack();
     weekContainer
       .layoutHorizontally();
     weekContainer
       .centerAlignContent();
     weekContainer.addSpacer();
     addWeekColumns(
       weekContainer,
       days,
       today,
       284
     );
     weekContainer.addSpacer();
   // -----------------------------------------------------
   // LARGE
   // -----------------------------------------------------
   } else {
     w.addSpacer(6);
     days.forEach(
       ([date, sessions]) => {
         if (
           !sessions.length
         ) {
           const row =
             w.addStack();
           row.centerAlignContent();
           const dayText =
             row.addText(
               `${dayAbbrFr(date)} ${formatDayFr(date)}`
             );
           dayText.font =
             Font.mediumSystemFont(
               11
             );
           dayText.textColor =
             new Color(
               "#4a5068"
             );
           row.addSpacer();
           const rest =
             row.addText(
               "repos"
             );
           rest.font =
             Font.systemFont(
               10
             );
           rest.textColor =
             new Color(
               "#4a5068"
             );
         } else {
           sessions.forEach(
             s =>
               addSessionRow(
                 w,
                 s,
                 true
               )
           );
         }
       }
     );
   }
 } catch (e) {
   const err =
     w.addText(
       `Erreur: ${e.message}`
     );
   err.font =
     Font.systemFont(
       12
     );
   err.textColor =
     Color.red();
 }
 return w;
}
// =========================================================
// LANCEMENT
// =========================================================
const widget =
 await createWidget();
if (
 config.runsInWidget
) {
 Script.setWidget(
   widget
 );
} else {
 await widget.presentMedium();
}
Script.complete();