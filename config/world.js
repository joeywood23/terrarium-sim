/* ============================================================
 * world.js — WORLD + shared simulation tuning: the platform/grid/fence,
 * terrain, camera, and cross-species mechanic DEFAULTS (hunger, grazing,
 * predation, death, predator AI, the breeding base, vegetation growth/
 * seeding). Per-creature and per-plant specifics now live in their own
 * config/species/*.json files (cfg/breeding/appearance), which override
 * these shared defaults at load. Imported by src/main.js.
 * ============================================================ */
export const CONFIG = {
  platform: {
    width:  480,  // X extent  (chunked terrain makes larger maps affordable)
    depth:  320,  // Z extent
    height: 1.2,  // Y thickness of the slab
  },
  grid: {
    enabled: true,
    divisions: 4, // cells per world unit-ish; computed against platform below
  },
  terrain: {
    segX: 480,      // heightfield resolution along X (1-unit cells)
    segZ: 320,      // heightfield resolution along Z
    chunk: 32,      // cells per render-chunk side; brush edits rebuild only touched chunks
    featureFreq: 3.12 / 240, // worldgen noise frequency in absolute world units, so a
                             // bigger map gets MORE hills/coves, not scaled-up ones
    brushSpeed: 5,  // world units / sec at full strength, brush centre

    // ---- Analytic field (simplex fBm + warp + ridge + redistribution) ----
    octaves:      6,    // fBm octaves: more = finer detail, more cost
    lacunarity:   2.0,  // per-octave frequency multiplier
    persistence:  0.5,  // per-octave amplitude multiplier (= gain); H=1 natural terrain
    warpStrength: 0.6,  // domain warp in x-space (~1 unit/wavelength). 0 disables.
    ridgeMix:     0.6,  // how strongly mountain-mask regions adopt ridged noise (0..1)
    redistPow:    2.5,  // pow(e,k) valley/peak shaping: >1 flattens lowland, sharpens peaks
    terraceLevels:   0, // 0 = off; e.g. 8 for mesa/plateau stepping
    terraceStrength: 0, // 0..1 partial terracing blend
    coastStart:   0.55, // island falloff inner edge (superellipse distance)
    coastWobble:  0.12, // organic-coastline noise amplitude added to the falloff distance
    seaBias:      0.06, // sea-level subtraction; raise to flood more, lower for more land

    // ---- Erosion bakes (whole-grid, run once on Generate) ----
    erosionDroplets: 70000, // droplet count for hydraulic erosion (0 disables the bake)
    erosionRadius:   3,     // cells the erosion footprint spreads over
    inertia:         0.05,  // 0 = water follows gradient exactly, 1 = keeps momentum
    sedimentCapacityFactor: 4,
    minSedimentCapacity:    0.01,
    erodeSpeed:      0.3,
    depositSpeed:    0.3,
    evaporateSpeed:  0.01,
    gravity:         4,
    maxDropletLifetime: 30,
    thermalIterations:  8,    // talus/scree smoothing passes (0 disables)
    thermalTalus:       0.6,  // max stable height diff between neighbours
    thermalFactor:      0.5,  // fraction of the excess slope moved per pass
    beachWidth:         2.0,  // shore-shelf band straddling water level (0 disables)
  },
  fence: {
    thickness: 1,      // wall thickness, world units
    waterFactor: 1.05, // wall top = water level x this, to retain the fill
  },
  breeding: {
    // Shared breeding defaults. Per-species overrides live in each species' JSON
    // (config/species/<id>.json "breeding"), merged onto these at load.
    _default: {
      mtbLayEgg:       30,   // mean seconds between layings
      layEggSpread:    0.5,  // +/- fraction of the mean for the random interval
      eggIncubation:   30,   // seconds from fertilization to hatch
      fertSuccessRate: 0.4,  // probability a qualifying passer fertilizes the egg
      fertRadius:      3,    // how close a second same-species adult must pass
      fertCooldown:    1.0,  // seconds before a failed roll can be retried
      unfertLifespan:  45,   // seconds an unfertilized egg survives before it spoils
      layCost:         0.35, // fraction of MAX reserve spent to lay an egg
      fertCost:        0.20, // fraction of MAX reserve a fertilizer spends
      growthFood:      30,   // food a newborn must EAT to reach adulthood (its "body
                             // mass"). Growth is food-gated, not time-gated: a baby
                             // that can't find food never matures (and can't breed).
      juvenileScale:   0.4,  // visual size at birth, grows to 1.0 as growth food fills
      useEggZone:      false,// route to the painted egg zone before laying
      seekTimeout:     20,   // give up routing to the zone after this long
    },
  },
  vegetation: {
    cap:          10000, // INITIAL plant buffer; grows on demand, no hard limit
    minRadius:    0.12,  // sphere radius when stripped bare (food 1/10)
    maxRadius:    1.8,   // sphere radius when lush (food 10/10) — 3x larger
    sprayAttempts: 14,   // placement tries per frame while painting
    spaceSparse:  5,     // min plant spacing at density 0
    spaceDense:   0.7,   // min plant spacing at density 1
    maxFood:      10,    // grazings a full plant can sustain before dying
    foodRegrow:   0.05,  // food/sec from sunlight. Slider -0.05..0.1: positive
                         // regrows, 0 freezes food (finite), negative starves
                         // plants until their mass dies off
    startFood:    1,     // a freshly planted sprout starts stripped, then grows
    seedRate:     0.03,  // per-plant chance/sec to expel a seed (kept low: "slowly")
    seedDist:     3.5,   // mean dispersal distance of a seed from its parent
    seedSpacing:  1.3,   // a landing within this of an existing plant counts as "occupied"
    seedMaxDepth: 0.4,   // seeds only take on land / waterline (max water depth to germinate)
  },
  soil: {                // per-patch carrying capacity: a cap on how many calories
                         // of plant matter a patch of ground can support. Paint it
                         // with the Soil brush. Over capacity, germination stops and
                         // 1-in-n plants begin to die back until load falls under cap.
    patch:      4,    // world units per soil patch (capacity + load granularity)
    defaultCap: 30,   // starting calories of plant matter a patch supports (unpainted)
    maxCap:     100,  // brush ceiling, and the value display/tint normalizes against
    brushSpeed: 140,  // calories/sec added (or removed with Shift) at full brush strength
    interval:   0.5,  // sim-seconds between carrying-capacity recomputes / die-back passes
    cullRate:   0.12, // per pass, chance an over-capacity plant starts dying (the "1 in n")
    dieRate:    4,    // calories/sec a dying plant sheds before it's removed (a visible wilt)
    // World-gen fertility field: instead of a flat default, derive each patch's
    // capacity from the biomass the vegetation layer actually seeds there (so the
    // overall density tracks the vegetation dial), modulated by world-seeded
    // noise into natural rich/poor patches.
    genFertility: true,  // false = flat defaultCap everywhere
    genFreq:     0.03,   // fertility-noise frequency (world units): smaller = broader patches
    genContrast: 1.3,    // >1 sharpens the rich/poor contrast
    fertMin:     0.5,    // capacity multiplier in the poorest patches
    fertMax:     1.8,    // capacity multiplier in the richest patches
    genHeadroom: 1.5,    // capacity = seeded biomass x this (growth room above the initial planting)
    genFloor:    8,      // baseline capacity in unseeded patches, so dispersal can slowly colonize
  },
  grass: {               // instanced 3D grass blades, scattered by soil fertility
    enabled:   true,
    maxBlades: 800000, // instanced-blade ceiling (rendered in a single draw call)
    attempts:  600000, // scatter darts (tuft centres); acceptance rises with fertility
    minFert:   0.04,   // normalized capacity (cap/maxCap) below which ground stays bare
    tuftMax:   8,      // extra blades clustered per accepted point at full fertility
    tuftRadius: 0.7,   // world-unit spread of a tuft's blades around its centre
    bladeW:    0.10,   // blade base width (world units)
    bladeH:    1.3,    // blade height at full fertility
    minScale:  0.45,   // height multiplier at minFert (shorter where soil is poor)
    wind:      0.14,   // tip sway amplitude (world units)
    windSpeed: 1.6,    // sway speed
    dryColor:  '#9fa84a', // tuft colour on poor soil (dry yellow-green)
    lushColor: '#2e7d27', // tuft colour on rich soil (lush green)
  },
  vegGen: {              // procedural vegetation layer, regenerated with the island
    attempts:    45000,  // dart throws over the map; each accepted by local density
    coastBand:   6,      // world units from the waterline where density stays at peak
    inlandReach: 60,     // shore distance at which land density has faded to the floor
    deepReach:   10,     // distance into water where aquatic plants stop (fish food)
    minDensity:  0.03,   // land floor so the deepest inland point is sparse, not barren
    clumpFreq:   0.045,  // patchiness noise frequency (absolute world units)
    clumpBias:   1.8,    // >1 sharpens patches into distinct groves and clearings
  },
  hunger: {
    max:      100,   // adult energy reserve capacity (full)
    babyMax:  25,    // immature creatures have a smaller reserve
    depleteRate: 0.12, // reserve lost per second (metabolism); eating refills it
    startMinFrac: 0.6, // creatures spawn with a reserve in this fraction range
    startMaxFrac: 1.0,
    reproMinFrac: 0.10, // below this fraction of max reserve, a creature neither
                        // lays eggs nor fertilizes — survival outranks breeding
    barWidth: 2.4,   // bar world width at full (max) capacity
    barHeight: 0.32,
  },
  grazing: {
    threshold:    0.5,  // seeks food when reserve drops to/below this fraction of max
    searchRadius: 40,   // how far it will look for the nearest reachable plant
    eatRange:     2.5,  // must be this close to stand and feed
    eatDuration:  3,    // seconds spent feeding before the plant is consumed
    gain:         10,   // reserve gained per plant eaten
  },
  predation: {          // the food web: live prey + carrion scavenging
    searchRadius: 48,   // predators/scavengers look a bit farther than grazers
    eatRange:     2.5,  // contact distance to feed on a corpse (carrion); live-prey
                        // catch uses each predator's own cfg.contactRadius instead
    preyGain:     16,   // reserve from eating a whole live insect
    biteDuration: 2.5,  // seconds per scavenging bite on a corpse
    biteGain:     9,    // reserve per corpse bite
    corpseMeat:   28,   // total scavengeable "meat" a fresh corpse holds
    retryDelay:   0.6,  // wait after a failed prey search before scanning again
  },
  predator: {           // predator behaviour state machine (resting | exploring | hunting)
    meanStateTime: 60,  // average game-seconds spent in a state before switching
    stateTimeStd:  18,  // std dev of the (normally distributed) per-state dwell time
    minStateTime:  6,   // floor so a small/negative normal sample can't thrash states
    huntRadius:    40,  // prey-search radius (n units) for the hunting path-seek
  },
  death: {
    starveTime: 60,   // seconds at 0 reserve before death
    decayTime:  120,  // seconds for a corpse to fade from full to gone
    sinkRate:   2,    // how fast a corpse settles to the bottom, units/s blend
  },
  camera: {
    fov: 45,
    near: 0.1,
    far: 2000,
    // distance multiplier applied to the platform's bounding radius for snap views
    fit: 1.9,
  },
  tween: { duration: 650 }, // ms for view-snap transitions
};
