# Training Load Dashboard — Node.js

Portage Node.js (Express + EJS + Chart.js) du dashboard Streamlit
`training_load_dashboard_api.py`. Fonctionne en serveur "tout-en-un" :
un seul process Node sert les pages HTML et une petite API JSON interne
utilisée par le JavaScript côté navigateur pour les graphiques et les
filtres interactifs.

## Fonctionnalités

- **Dashboard** : charge Foster quotidienne par sport (+ courbe 7 jours
  glissants et prolongation planifiée), volume CAP (km / D+ / heures),
  volume vélo (km / D+ / heures / kJ), ACWR (avec zone de référence
  1,0–1,3, prévisionnel à partir des séances planifiées et marqueurs de
  courses), détail des séances.
- **Planification & envoi** : bibliothèque de séances (Run/Ride,
  templates simples ou échauffement/répétitions/récup/retour au calme)
  avec génération automatique de la description au format Intervals.icu,
  mode personnalisé, envoi direct vers le calendrier Intervals.icu,
  consultation des séances déjà planifiées, planificateur de semaine
  (répartition CAP/Vélo/Muscu à partir de la charge chronique et d'un
  objectif d'ACWR) avec tableau éditable et graphique de répartition,
  proposition de semaine via IA (Claude) tenant compte de la charge
  chronique, du type de semaine et de contraintes en texte libre
  (note de cycle).

## Installation

```bash
npm install
cp .env.example .env
# éditer .env et renseigner INTERVALS_API_KEY (et éventuellement ANTHROPIC_API_KEY)
npm start
```

Le serveur écoute par défaut sur `http://localhost:3000`.

`INTERVALS_API_KEY` se trouve sur Intervals.icu dans
**Settings → Developer Settings → API Key**. La clé reste côté serveur
(fichier `.env`), elle n'est jamais envoyée au navigateur.

`ANTHROPIC_API_KEY` (optionnelle) active le bouton « ✨ IA » du
planificateur de semaine (aide planif) : sans cette clé, le bouton
reste disponible mais renvoie une erreur explicite, le reste de
l'application fonctionne normalement. `ANTHROPIC_MODEL` (optionnelle)
permet de surcharger le modèle utilisé (par défaut
`claude-3-5-sonnet-20241022`).

Le fournisseur du bouton « ✨ IA » est configurable via `AI_PROVIDER` :
- `anthropic` (défaut) : Claude, payant (nécessite des crédits sur le
  compte Anthropic) — `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`.
- `groq` : gratuit, sans carte bancaire, clé sur
  https://console.groq.com/keys — `GROQ_API_KEY` / `GROQ_MODEL`
  (défaut `llama-3.3-70b-versatile` ; si ce modèle n'est plus disponible
  pour ta clé, le serveur retente automatiquement avec un modèle Llama
  disponible — la liste peut aussi être consultée avec
  `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`).
- `ollama` : 100% local et gratuit, nécessite [Ollama](https://ollama.com)
  installé (`ollama serve` + `ollama pull llama3.1`) —
  `OLLAMA_BASE_URL` (défaut `http://localhost:11434`) / `OLLAMA_MODEL`
  (défaut `llama3.1`).

Exemple pour tester gratuitement avec Groq, dans `.env` :
```
AI_PROVIDER=groq
GROQ_API_KEY=gsk_...
```

## Sécuriser l'accès

Par défaut, les pages `/dashboard` et `/planning` sont accessibles à
quiconque connaît l'URL. Pour exiger une connexion (page `/login`),
renseigne dans `.env` :
```
DASHBOARD_USER=...
DASHBOARD_PASS=...
```
Une fois connecté, un cookie de session signé (HMAC, `DASHBOARD_SESSION_SECRET`
optionnel) garde l'accès pendant 30 jours ; un bouton « Déconnexion » apparaît
dans la barre de navigation. Si l'une des deux variables est absente, aucune
authentification n'est demandée (comportement inchangé). Les identifiants ne
sont jamais envoyés au navigateur ; en local, place-les dans `.env` (non
commité) ; sur Vercel, dans les variables d'environnement du projet.

Les endpoints utilisés par les widgets iOS (`/api/dashboard-data` via
`WIDGET_TOKEN`) ne sont pas concernés par cette protection : ils continuent de
fonctionner indépendamment via leur propre token en query string.

## Structure du projet

```
server.js                 point d'entrée Express
routes/
  dashboard.js             page /dashboard + API JSON /api/dashboard-data
  planning.js               page /planning + API JSON (calendrier, envoi, chronique)
src/
  intervalsApi.js           client HTTP Intervals.icu (+ cache mémoire 5 min)
  calculations.js           port des calculs pandas : charge Foster, ACWR, prévisionnel
  dashboardData.js          composition des données du dashboard pour l'API JSON
  athletes.js                liste des athlètes (compte coach)
  planningData.js            charge chronique + calendrier planifié
  aiPlanner.js               proposition de semaine via IA (Claude, aide planif)
  sessionLibrary.js          bibliothèque de séances + génération de description (UMD)
  planBuilder.js             planificateur de semaine déterministe (UMD)
  format.js                  formatage des durées (UMD)
  dateUtils.js                utilitaires de dates (semaines lundi→dimanche)
views/                      templates EJS (dashboard, planning)
public/
  css/style.css
  js/dashboard.js            filtres + rendu des graphiques Chart.js
  js/planning.js              bibliothèque de séances + planificateur (côté client)
```

Les modules UMD de `src/` (`format.js`, `sessionLibrary.js`,
`planBuilder.js`) sont utilisés à la fois côté serveur (`require`) et
côté navigateur (servis tels quels sous `/vendor/…`), pour éviter toute
duplication de logique entre les deux.

## Notes de portage

- Les calculs pandas (`daily_load`, `calculate_load_metrics`,
  `calculate_forecast_acwr`, etc.) ont été réécrits en JavaScript pur
  (tableaux/objets), sans dépendance équivalente à pandas.
- Le filtrage "Période" et "Activités" du dashboard, ainsi que le
  planificateur de semaine, recalculent côté serveur / côté client à
  partir des données déjà chargées — pas de nouvel appel à l'API
  Intervals.icu tant que la plage d'historique ou l'athlète ne change
  pas (cache mémoire de 5 minutes, comme `@st.cache_data(ttl=300)` dans
  la version Streamlit).
- Le tableau `zone_totals` (répartition par zones FC/puissance) présent
  dans le script Python n'était relié à aucun graphique affiché dans le
  dashboard d'origine ; il n'a pas été porté.
