# Camping-car-API

API Node.js multi-source pour collecter, normaliser et exposer des données d'aires pour camping-cars.

## Sources

Chaque enregistrement conserve explicitement sa plateforme (`source.platform`, `source.sourceId`). Le connecteur **Camping-Car Park** collecte uniquement des données publiques accessibles sans contournement d'authentification, CAPTCHA ou protection anti-bot. Les autres plateformes doivent être branchées via une API officielle, une licence ou une source dont l'utilisation est autorisée.

Le registre inclut Park4night comme connecteur désactivé par défaut : aucune donnée n'est récupérée de cette plateforme tant qu'une méthode autorisée n'est configurée.

## Installation

```bash
npm install
cp .env.example .env
npm start
```

Collecte :

```bash
npm run collect
```

Les données sont écrites atomiquement dans `data/memories.json`.

## API

- `GET /api/v1/health`
- `GET /api/v1/sources`
- `GET /api/v1/parks`
- `GET /api/v1/parks/:id`
- `GET /api/v1/search?q=France`
- `GET /api/v1/nearby?lat=43.7&lon=4.8&radius=25`
- `GET /api/v1/statistics`
- `POST /api/v1/admin/collect`

Les routes de données utilisent `x-api-key` ou `Authorization: Bearer ...` lorsque `API_KEY` est configurée. L'API applique Helmet, CORS configurable, rate limiting et limites JSON.

## Architecture

`collectors/` = acquisition par plateforme.  
`normalizers/` = modèle commun et déduplication.  
`storage/` = persistance de `memories.json`.  
`api/` = endpoints HTTP.  
`.github/workflows/collect.yml` = collecte planifiée toutes les 6 heures.

## Important

Ce projet ne doit pas contourner les contrôles d'accès, les CAPTCHA, les protections anti-bot ou les conditions d'utilisation des plateformes. Pour une source tierce, utiliser une API/documentation officielle ou une autorisation appropriée.
