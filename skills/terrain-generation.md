# Terrain Generation — Implementation Guide

**Purpose:** Compressed, implementation-ready reference for building a realistic, art-directable procedural terrain generator for **Terrarium** (browser, Three.js, no build step, Three.js as the only dep). Written for a coding agent. Output **must** stay a 2D heightfield `y = f(x,z)` so existing `sampleHeight`/`waterDepthAt`/`computeShoreDist`/vegetation/creature code keeps working.

**Last Updated:** 2026-06-18

> **Implementation status (2026-06-18):** Stages 1–4 are now **implemented** in `src/main.js`. The generator is no longer value-noise. Current state: seeded 2D **simplex** noise (`snoise` + per-seed `buildPerm`), `fbm`/`ridged` helpers, an analytic `terrainHeightAt` with **domain warp + ridged mountain mask + `pow` redistribution + organic (noise-perturbed) coastline**, and whole-grid **bakes** in `generateIsland`: `hydraulicErode()` → `thermalErode()` → `shoreShelf()`. All knobs live in `CONFIG.terrain` (`config/world.js`). Stage 5 (moisture/biome map) is the remaining follow-on. Sections below are the design reference these were built from.

---

## 0. Where this plugs into the current code (`src/main.js`)

The generator (read before editing):

- `terrainHeightAt(wx, wz)` — **pure worldgen seam.** Now: simplex `fbm` with domain warp + ridge blend + `pow(e,redistPow)` redistribution × organic falloff, clamped to `worldHeight`. Stays pure & deterministic (depends only on `wx, wz, worldSeed` via the seeded perm table) so per-chunk / streaming generation stays border-consistent. **Analytic only** — the sculpt brush calls into this path, so erosion must NOT live here.
- `generateIsland()` — reseeds the perm table (`buildPerm`), fills the `heights` typed array via `terrainHeightAt`, then runs the erosion bakes (`hydraulicErode` → `thermalErode` → `shoreShelf`), reclamps to `[0, worldHeight]`, then `refreshTerrain()` + `markFlowDirty()` + `generateVegetation()`.
- `snoise` / `buildPerm` / `fbm(x,z,opts)` / `ridged(x,z,opts)` — current noise stack. `fbm`/`ridged` take an options object (`{octaves,lacunarity,gain}`) and output ~`[-1,1]` / ~`[0,1]`. (The old `valueNoise`/`hash2` value-noise stack has been removed.)
- `sampleHeight(x,z)` — bilinear sample of `heights`. **Do not change its contract** (returns world-Y).
- Globals: `worldSeed`, `worldAmp` (UI `#island-amp`), `worldHeight` (wall ceiling), `T = CONFIG.terrain`, `P = CONFIG.platform`.
- `heights` is a flat `NX*NZ` array; `dx,dz` are cell sizes (≈1 unit). `NX=segX+1`, `NZ=segZ+1`.

**Two-tier design (important):** A *pure analytic* `terrainHeightAt` (noise+masks, cheap, stateless) is what the **sculpt brush** and any future streaming should call for instant local rebuilds. **Erosion is a stateful whole-grid pass** — it cannot run per-cell. So:

- Keep `terrainHeightAt` analytic-only (noise + warp + mask + redistribution).
- Run erosion **once, as a bake** inside `generateIsland()` over the full `heights` array, *after* the analytic fill. Store the eroded result in `heights`.
- Sculpt brush keeps editing `heights` directly (as today). It does **not** re-run erosion. (Optional: a "re-erode" button.)

---

## 1. Decision guide (goal → technique)

| Goal | Use | Section |
|---|---|---|
| Base shape, rolling hills | fBm (gradient noise, ≥5 oct) | 2, 3 |
| Sharp mountain **ridges** | Ridged multifractal noise | 4 |
| Winding valleys / "eroded" look cheaply | **Domain warping** | 5 |
| Believable coastline + central landmass | Island mask (falloff / radial / warped) | 7 |
| Flat valleys + steep peaks | Redistribution power curve `pow(e, k)` | 6 |
| Plateaus / mesas | Terracing `round(e*n)/n` (smoothed) | 6 |
| Real river valleys, sediment, realism | **Droplet hydraulic erosion** (bake) | 8 |
| Cliffs collapsing to talus slopes | Thermal erosion (bake) | 9 |
| Beaches / shelves at the waterline | Shore flattening near `water.level` | 10 |
| Don't look fake | Avoid pitfalls | 11 |

---

## 2. Noise foundations — pick the right primitive

- **Value noise** (what the project uses now): interpolate random lattice values. Cheap, but visibly **blobby / grid-aligned** and lower frequency content — a major reason current terrain looks "fake." ([wiki](https://en.wikipedia.org/wiki/Value_noise))
- **Perlin noise:** gradient noise; better, but has **axis-aligned directional artifacts** (features biased to the grid axes). ([wiki](https://en.wikipedia.org/wiki/Gradient_noise))
- **Simplex / OpenSimplex:** gradient noise on a simplex lattice — **far fewer directional artifacts**, smoother, scales better to higher dims. OpenSimplex is patent-free. **Recommended primitive.** ([Simplex](https://en.wikipedia.org/wiki/Simplex_noise), [OpenSimplex](https://en.wikipedia.org/wiki/OpenSimplex_noise), [bit-101 Perlin vs Simplex](https://www.bit-101.com/2017/2021/07/perlin-vs-simplex/))

**Recommendation for Terrarium:** Replace `valueNoise` with a self-contained **2D OpenSimplex/Simplex** function (≈40 lines, no deps — port from a public-domain JS gist; output to `[-1,1]`, remap to `[0,1]` where needed). Keeping it inline preserves "no build step / Three.js only." If staying minimal, at minimum upgrade value noise → gradient (Perlin) noise; the artifact reduction is the single biggest realism win for the least effort.

---

## 3. fBm (fractal Brownian motion)

Sum octaves of noise at doubling frequency, halving amplitude. Self-similarity matches how erosion shapes real mountains across scales. ([iq fBm](https://iquilezles.org/articles/fbm/), [Red Blob noise](https://www.redblobgames.com/maps/terrain-from-noise/))

```js
// noise(x,z) in [-1,1]. Returns ~[-1,1].
function fbm(x, z, seed, { octaves=6, lacunarity=2.0, gain=0.5 } = {}) {
  let sum=0, amp=1, freq=1, norm=0;
  for (let o=0; o<octaves; o++) {
    sum  += amp * noise(x*freq + seed, z*freq + seed*1.7);
    norm += amp;
    amp  *= gain;          // gain = persistence; G = 2^(-H), H=1 → G=0.5 for terrain
    freq *= lacunarity;    // use 2.0 (or 2.0+ε to break tiling alignment)
  }
  return sum / norm;
}
```

**Params & defaults:** `octaves 5–7` (more = finer detail, more cost), `lacunarity ≈ 2.0`, `gain/persistence 0.5` (H=1, the spectrally-correct value for natural terrain; lower → smoother, higher → rougher/noisier). ([iq fBm](https://iquilezles.org/articles/fbm/))

---

## 4. Ridged & billowy noise (mountain ridges)

Reshape each octave to make creases/peaks instead of smooth blobs.

```js
// RIDGED: sharp ridgelines (mountains). noise in [-1,1].
function ridged(x,z,seed,{octaves=6,lacunarity=2.0,gain=0.5}={}) {
  let sum=0, amp=0.5, freq=1, prev=1;
  for (let o=0;o<octaves;o++){
    let n = 1 - Math.abs(noise(x*freq+seed, z*freq+seed*1.7)); // crease at 0
    n *= n;                  // sharpen ridge
    n *= prev;               // feedback: detail concentrates on existing ridges
    sum += n*amp; prev=n; freq*=lacunarity; amp*=gain;
  }
  return sum;
}
// BILLOWY: puffy hills → use abs(noise) instead of 1-abs(noise).
```

**When:** ridged for alpine ranges; blend ridged into fBm by a low-freq "mountain mask" so ranges occur in regions, not everywhere: `h = lerp(fbm, ridged, smoothstep(0.5,0.8, mountainMask))`. ([iq fBm](https://iquilezles.org/articles/fbm/) discusses ridged/erosion-like variants.)

---

## 5. Domain warping — the cheapest realism upgrade

Distort the *input coordinates* with more noise before sampling: `f(p) = fbm(p + W·fbm(p + W·fbm(p)))`. Produces meandering valleys, swirled ridges, and "eroded" structure without an erosion sim. **High realism-per-line — do this.** ([iq warp](https://iquilezles.org/articles/warp/))

```js
function warpedHeight(x, z, seed) {
  // first warp layer
  const qx = fbm(x, z, seed);
  const qy = fbm(x+5.2, z+1.3, seed);
  // second (nested) warp layer
  const rx = fbm(x + 4.0*qx + 1.7, z + 4.0*qy + 9.2, seed);
  const ry = fbm(x + 4.0*qx + 8.3, z + 4.0*qy + 2.8, seed);
  return fbm(x + 4.0*rx, z + 4.0*ry, seed);   // base eval on warped domain
}
```

**Params:** warp strength `4.0` (the `4.0*` multipliers) — raise for more turbulence, lower for gentle meander. One warp layer is often enough; two = more organic. Offsets (5.2, 1.3, …) just decorrelate the channels. ([iq warp](https://iquilezles.org/articles/warp/))

---

## 6. Redistribution & terracing (valley/peak shaping, plateaus)

Apply **after** normalizing height `e` to `[0,1]`. ([Red Blob noise](https://www.redblobgames.com/maps/terrain-from-noise/))

```js
e = Math.pow(e, k);              // k>1: flat valleys + sharp peaks. k≈2–4. fudge: pow(e*1.1,k)
e = Math.round(e*n)/n;           // terracing: n levels (4–12) → plateaus/mesas
// smoothed terrace (avoids hard steps): blend toward stepped value
const stepped = Math.round(e*n)/n;
e = e*(1-terraceStrength) + stepped*terraceStrength;  // terraceStrength 0–1
```

- **Power curve** `pow(e,k)` is the single best "make it look like terrain not hills" knob after warping. Real landscapes have lots of low/flat land and few high peaks.
- **Terracing** for mesas/rice-terrace looks; keep it *partial* or it looks CG. Apply *before* erosion so erosion softens the steps naturally.

---

## 7. Island / coastline shaping

Multiply or blend elevation by a **falloff mask** so land sits centrally and drops to water at the rim. The project already does a rounded-rect falloff; upgrade it for organic coasts. ([Red Blob noise](https://www.redblobgames.com/maps/terrain-from-noise/), [Red Blob island shaping](https://simblob.blogspot.com/2022/04/improving-island-shaping-for-map.html))

```js
// normalized coords u,v in [-1,1] over the platform
// (A) radial / superellipse distance (current style, p controls squareness)
const d = Math.pow(Math.abs(u)**p + Math.abs(v)**p, 1/p);  // p=2 round, p≥4 squarish
let mask = 1 - smoothstep(coastStart, 1.0, d);             // coastStart≈0.55

// (B) ORGANIC coast: perturb the distance with low-freq noise so the shoreline wiggles
const coastWobble = 0.18 * fbm(u*2.2, v*2.2, seed+555);    // breaks the geometric rim
mask = 1 - smoothstep(coastStart, 1.0, d + coastWobble);

// combine: subtract a sea-level bias so coastline forms where noise·mask crosses 0
height = Math.max(0, elevation * mask - seaBias) * worldAmp;  // seaBias≈0.10
```

**Tips:** blend (`lerp(e, 1-d, mix)`) instead of pure multiply for gentler shelves; add the noise *to the distance* (B) for believable bays/peninsulas instead of an ellipse. For multiple islands or richer coasts, a Voronoi/cellular term can carve archipelagos, but for a single bounded platform the warped-falloff approach is sufficient and cheaper. Keep the existing `worldHeight` clamp (terrain can't exceed the fence).

---

## 8. Hydraulic erosion (droplet) — the realism centerpiece (BAKE)

Simulate rain droplets that flow downhill, **erode** where fast, **deposit** sediment where they slow/turn uphill. Carves dendritic river valleys, ridgelines, and sediment fans that noise alone can't. Run **once** over the full `heights` grid inside `generateIsland()` after the analytic fill. ([Sebastian Lague repo](https://github.com/SebLague/Hydraulic-Erosion), [Erosion.cs](https://github.com/SebLague/Hydraulic-Erosion/blob/master/Assets/Scripts/Erosion.cs))

**Defaults (from Lague's Erosion.cs):**
```
erosionRadius 3      inertia 0.05         sedimentCapacityFactor 4
minSedimentCapacity 0.01   erodeSpeed 0.3 depositSpeed 0.3
evaporateSpeed 0.01  gravity 4           maxDropletLifetime 30
initialWaterVolume 1 initialSpeed 1      numDroplets ≈ 70k–200k (scale to grid area)
```

**Per-droplet loop (pseudocode):**
```
for each droplet (random start in grid):
  pos, dir=(0,0), speed=1, water=1, sediment=0
  for step in 0..maxLifetime:
    (h, grad) = heightAndGradient(pos)          // bilinear over 4 cells
    dir = dir*inertia - grad*(1-inertia); normalize(dir)
    newPos = pos + dir
    if out-of-bounds or |dir|≈0: break
    dh = height(newPos) - h
    capacity = max(-dh * speed * water * sedimentCapacityFactor, minSedimentCapacity)
    if sediment > capacity OR dh > 0:           // deposit (slowing / uphill)
      amt = (dh>0) ? min(dh, sediment) : (sediment-capacity)*depositSpeed
      deposit amt onto the 4 cells of the OLD pos (bilinear weights); sediment -= amt
    else:                                        // erode
      amt = min((capacity-sediment)*erodeSpeed, -dh)
      remove amt spread over a brush of radius erosionRadius around OLD pos; sediment += amt
    speed = sqrt(max(0, speed*speed + dh*gravity))
    water *= (1 - evaporateSpeed)
    pos = newPos
```

**Notes for Terrarium:**
- Erode the working `heights` array directly; precompute the **erosion brush** (cell offsets + weights for radius `r`) once.
- **Cost:** ~`numDroplets * maxLifetime` cell ops. For 480×320 (~154k cells) use ~100k droplets — runs in a fraction of a second to a couple seconds in JS. Acceptable as a one-time bake on "Generate." If it stalls the main thread, chunk the droplet loop across a few frames or run in a Web Worker (still no build step).
- Erode **before** the shore-flatten pass (§10) and before recomputing normals/flow.
- This is what makes valleys read as *carved by water* — the difference between "fake" and "believable."

---

## 9. Thermal erosion (talus / angle-of-repose) — optional (BAKE)

Where a slope exceeds the material's **talus angle**, move material downslope until stable. Turns noisy cliffs into natural scree slopes; softens terrace steps. Cheap, iterative grid pass. ([Axel Paris](https://aparis69.github.io/public_html/posts/terrain_erosion.html), [Unity thermal erosion](https://docs.unity3d.com/Packages/com.unity.terrain-tools@4.0/manual/erosion-thermal.html))

```
repeat iterations (10–50):
  for each cell c:
    for each lower neighbor n: di = h[c]-h[n]
    dmax = max(di); if dmax <= T: continue            // T = talus threshold (height diff)
    moved = c_factor * (dmax - T)                     // c_factor 0.5
    distribute `moved` to neighbors with di>T, weighted by di/sum(di>T)
    h[c] -= moved
```

**When:** after hydraulic erosion for extra naturalism, or instead of it if you need a cheaper pass. `T` controls how steep slopes may stay; lower `T` = smoother, more sediment movement.

---

## 10. Shore / beach shelf

After erosion, give the waterline a believable beach instead of a hard noise edge. (Vegetation/creatures already key off `computeShoreDist` and `water.level`.)

```
// flatten a band straddling water.level toward a gentle shelf
band = |height - water.level|
if band < beachWidth:                       // beachWidth ≈ 1.5–3 world units
  t = smoothstep(0, beachWidth, band)
  height = lerp(shelfTarget, height, t)     // pulls near-shore cells toward a flat shelf just above water
```

Keep it subtle; the goal is a sand shelf and shallow underwater shelf, not a plateau. This also makes `waterDepthAt` produce a gradual shallow zone (good for aquatic plant/fish placement).

---

## 11. Biome / elevation banding (high level)

Terrarium layers vegetation by **shore distance + height** already (`vegGen.coastBand/inlandReach`, `clumpFreq`). For a richer world, add a second low-freq **moisture** map and let downstream code band by `(elevation, moisture)` — a Whittaker-style 2-axis scheme. Use a **separate seed** (or coord offset `+1000`) for moisture so it decorrelates from elevation. Erosion-derived wetness (cells that accumulated water/sediment) is an even better moisture proxy if you track it during §8. ([Red Blob biomes](https://www.redblobgames.com/maps/terrain-from-noise/), [mapgen4](https://www.redblobgames.com/maps/mapgen4/))

This guide's scope is the heightfield; moisture/biome is a follow-on that reuses the same noise stack.

---

## 12. Common pitfalls → fixes ("why it looks fake")

- **Blobby, grid-aligned hills** → value/Perlin artifacts. Fix: Simplex/OpenSimplex (§2) + domain warp (§5).
- **Uniform roughness everywhere** → no scale separation. Fix: low-freq region masks (mountain mask, moisture) gating high-freq detail.
- **Too smooth / all mid-elevation** → missing redistribution. Fix: `pow(e,k)`, k≈2–4 (§6).
- **No drainage / valleys go nowhere** → no erosion. Fix: droplet erosion (§8) — the big one.
- **Geometric ellipse coastline** → fix: perturb falloff distance with noise (§7B).
- **Hard sea edge / cliff beaches** → fix: shore shelf (§10).
- **Visible chunk seams** → ensure `terrainHeightAt` is purely analytic & seed-only (no per-chunk RNG), and bake erosion over the *whole* grid, never per chunk.
- **Tiling/repetition** → use lacunarity `2.0+ε` and per-octave seed/offset so octaves don't phase-align.

---

## 13. Recommended pipeline (default recipe)

Order of operations inside an upgraded `generateIsland()`:

1. **Noise primitive:** swap `valueNoise` → inline 2D **OpenSimplex** (output `[-1,1]`). *(biggest cheap win)*
2. **Analytic field (`terrainHeightAt`, pure):**
   1. `e = warpedHeight(wx*featureFreq, wz*featureFreq, seed)` — fBm **with domain warp** (§3+§5).
   2. blend in **ridged** noise where a low-freq mountain mask is high (§4).
   3. remap `e` to `[0,1]`, apply **redistribution** `pow(e, k)` (k≈2.5), optional partial **terrace** (§6).
   4. apply **organic island mask** (warped falloff, §7B) and `seaBias`; scale by `worldAmp`; clamp to `worldHeight`.
3. **Fill `heights`** from `terrainHeightAt` (existing loop). *(Brush & streaming stop here — analytic only.)*
4. **Bake hydraulic erosion** over the full `heights` grid (§8) — the realism centerpiece.
5. *(optional)* **Thermal erosion** smoothing pass (§9).
6. **Shore shelf** pass near `water.level` (§10).
7. `refreshTerrain()` + `markFlowDirty()` + `generateVegetation()` (unchanged).

**Suggested new `CONFIG.terrain` keys** (defaults in parens):
```js
terrain: {
  // ...existing...
  noise:      'opensimplex',   // primitive
  octaves:     6,              // fBm octaves
  lacunarity:  2.0,
  persistence: 0.5,            // = gain
  warpStrength: 4.0,           // domain warp (0 disables)
  ridgeMix:    0.6,            // how strongly mountain regions use ridged noise
  redistPow:   2.5,            // pow(e,k) valley/peak shaping
  terraceLevels: 0,            // 0 = off; e.g. 8 for mesas
  terraceStrength: 0.0,        // 0..1 partial terracing
  coastStart:  0.55,           // island falloff inner edge
  coastWobble: 0.18,           // organic coastline noise amplitude
  seaBias:     0.10,           // sea-level subtraction
  beachWidth:  2.0,            // shore shelf band
  // erosion bake (Lague defaults)
  erosionDroplets: 100000, erosionRadius: 3, inertia: 0.05,
  sedimentCapacityFactor: 4, minSedimentCapacity: 0.01,
  erodeSpeed: 0.3, depositSpeed: 0.3, evaporateSpeed: 0.01,
  gravity: 4, maxDropletLifetime: 30,
  thermalIterations: 0, thermalTalus: 0.6, thermalFactor: 0.5,
}
```

**Staging (ship incrementally, each step alone improves realism):**
- **Stage 1 (1–2 hrs):** OpenSimplex + domain warp + `pow(e,k)`. Likely fixes 70% of the "fake" look.
- **Stage 2:** organic coastline (§7B) + shore shelf (§10).
- **Stage 3:** ridged mountain regions (§4).
- **Stage 4:** hydraulic erosion bake (§8) — biggest realism jump, most code.
- **Stage 5 (optional):** thermal pass, moisture/biome map.

Keep `terrainHeightAt` analytic so the sculpt brush stays instant; erosion lives only in the bake.

---

## References

- Inigo Quilez — fBm: https://iquilezles.org/articles/fbm/
- Inigo Quilez — Domain warping: https://iquilezles.org/articles/warp/
- Red Blob Games — Making maps with noise functions: https://www.redblobgames.com/maps/terrain-from-noise/
- Red Blob Games — Mapgen4: https://www.redblobgames.com/maps/mapgen4/
- Red Blob Games — Improving island shaping: https://simblob.blogspot.com/2022/04/improving-island-shaping-for-map.html
- Sebastian Lague — Hydraulic Erosion (repo): https://github.com/SebLague/Hydraulic-Erosion
- Lague — Erosion.cs (droplet algorithm + defaults): https://github.com/SebLague/Hydraulic-Erosion/blob/master/Assets/Scripts/Erosion.cs
- Axel Paris — Terrain Erosion on the GPU (thermal + hydraulic): https://aparis69.github.io/public_html/posts/terrain_erosion.html
- Unity — Thermal Erosion (talus angle): https://docs.unity3d.com/Packages/com.unity.terrain-tools@4.0/manual/erosion-thermal.html
- Jákó — Fast Hydraulic and Thermal Erosion on the GPU: https://old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf
- Wikipedia — Value noise / Gradient noise / Simplex / OpenSimplex: https://en.wikipedia.org/wiki/Value_noise , https://en.wikipedia.org/wiki/Simplex_noise , https://en.wikipedia.org/wiki/OpenSimplex_noise
- bit-101 — Perlin vs Simplex: https://www.bit-101.com/2017/2021/07/perlin-vs-simplex/
- dandrino — terrain-erosion-3-ways (reference implementations): https://github.com/dandrino/terrain-erosion-3-ways
