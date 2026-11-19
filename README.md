# Meet in the Middle · Ahmedabad

Friends enter where they live; the app finds the fairest café, restaurant or mall to meet at,
and replays **Dijkstra's algorithm** running on Ahmedabad's real road network as a colored wave per friend.
Where the waves overlap, venues light up; the winner pulses and everyone's route is traced in.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (no backend)
```

## How it works

| Step | Where | What |
|---|---|---|
| Input | `src/ui/panel.ts`, `src/geo/geocode.ts` | Nominatim search (bounded to Ahmedabad, search-on-submit, ≤1 req/s) or drop a pin. |
| Roads | `public/data/ahmedabad.bin` | Pre-baked city graph (see below). Live Overpass with mirror fallback is used only when friends are outside the baked area. |
| Graph | `src/graph/graph.ts` | Crop to padded bbox → CSR adjacency. Edge weight = length ÷ speed, speed from `maxspeed` (×0.75 for traffic) or per-class defaults; `oneway`, roundabouts and motorways respected. Union-find keeps snapping on the largest connected component. |
| Dijkstra | `src/graph/dijkstra.ts`, `src/graph/heap.ts` | Hand-written binary heap with lazy deletion. Records settle order + time and parent pointers. One run per friend, in a Web Worker. |
| Scoring | `src/scoring.ts` | Three fairness modes over the venue × friend travel-time matrix. Switching mode only re-sorts, with no new graph search. |
| Animation | `src/render/waveLayer.ts` | One MapLibre custom WebGL layer. Each road segment is an instanced quad carrying every friend's arrival time at both ends; the fragment shader reveals the wave where `arrival ≤ u_time`, with additive blending so overlapping friends mix toward white. |
| Finale | `src/render/overlays.ts`, `src/render/show.ts` | Dim → winner pulse → routes traced from parent pointers, synchronized to travel time → result card. |
| Sharing | `src/share.ts` | `#m=max&f=Name@lat,lon&…` (4-decimal coords ≈ 11 m). Opening a link replays the result. |

### Fairness modes
- **No long hauls** (default): minimize the longest trip.
- **Least driving**: minimize the sum of all trips.
- **Most equal**: minimize longest − shortest, among venues whose longest trip is within 1.4× of the best possible. Without that guard, "everyone drives 50 minutes" counts as perfectly fair.

### Refreshing the road data
Public Overpass servers are often overloaded, so the city is fetched once at build time in 16 tiles (cached, resumable):

```bash
npm run fetch-city   # → data/raw/ahmedabad.json   (retries across mirrors)
npm run bake-city    # → public/data/ahmedabad.bin
```

The city box, road classes, speeds and limits are all in `src/config.ts`.

### Limits & failure handling
- 2–5 friends, all within 25 km of each other (`MAX_SPAN_KM`); the app tells you when you exceed it.
- A home more than 600 m from a drivable road is rejected with a message on that friend's row.
- Address not found, Nominatim rate limit, and Overpass timeout / 429 (tries 3 mirrors) all surface a message, with a Retry where useful.
- Travel times are free-flow estimates, not live traffic.

Data © OpenStreetMap contributors (ODbL). Basemap © CARTO.
