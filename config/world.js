/* ============================================================
 * world.js — simulation tuning. All the dials for terrain, water,
 * creatures, breeding, vegetation, grazing, predation and the player.
 * Edit values here; comments explain each. Imported by src/main.js.
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
  },
  fence: {
    thickness: 1,      // wall thickness, world units
    waterFactor: 1.05, // wall top = water level x this, to retain the fill
  },
  fish: {
    length: 2.6,       // hitbox X (local), world units
    width:  0.9,       // hitbox Z
    height: 0.5,       // hitbox Y
    speed: 9,          // cruise speed, units/sec
    yawNoise: 1.5,     // wander, radians/sec of random yaw drift
    pitchNoise: 0.6,   // wander, radians/sec of random pitch drift
    pitchMax: 0.7,     // max nose-up/down angle in radians (~40°)
    steerRate: 3,      // radians/sec yaw/pitch correction toward a target
    lookAhead: 7,      // obstacle probe distance
    depthMargin: 0.25, // extra water depth required beyond hitbox height
    surfaceMargin: 0.3,// how close to the surface fish cruise before pitching down
    gravity: 25,       // fall acceleration when beached, units/s^2
    flopHoriz: 6,      // horizontal flop impulse, units/s
    flopVert: 6.5,     // vertical flop impulse, units/s
  },
  breeding: {
    // Shared defaults; each species below overrides only what differs.
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
    fish:    { mtbLayEgg: 25, fertRadius: 3, useEggZone: true },
    frog:    { mtbLayEgg: 32, fertRadius: 3 },
    insect:  { mtbLayEgg: 14, fertRadius: 2, growthFood: 14, juvenileScale: 0.5 },
  },
  vegetation: {
    cap:          10000, // INITIAL plant buffer; grows on demand, no hard limit
    minRadius:    0.12,  // sphere radius when stripped bare (food 1/10)
    maxRadius:    1.8,   // sphere radius when lush (food 10/10) — 3x larger
    sprayAttempts: 14,   // placement tries per frame while painting
    spaceSparse:  5,     // min plant spacing at density 0
    spaceDense:   0.7,   // min plant spacing at density 1
    colorYoung:   0x9bd66a, // light green (stripped/young)
    colorOld:     0x214d16, // dark green (lush)
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
    eatRange:     2.5,  // contact distance to seize prey / feed on a corpse
    catchDuration: 2,   // seconds to catch & swallow a live insect (one gulp)
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
  frog: {
    length: 1.6,       // hitbox X (local) — shorter than it is wide
    width:  2.2,       // hitbox Z — squat frog footprint
    height: 0.9,       // hitbox Y
    hopHoriz: 5,       // horizontal hop impulse, units/s
    hopVert: 5.5,      // vertical hop impulse, units/s
    hopWaitMin: 0.8,   // idle between hops, seconds
    hopWaitMax: 2.2,
    maxWade: 0.6,      // deepest water it can stand in before it's swimming
    paddleSpeed: 4,    // surface paddling speed when swamped
    gravity: 25,
  },
  bird: {
    length: 4.5,       // hitbox X (local) — 3x scale
    width:  2.4,       // hitbox Z
    height: 3.0,       // hitbox Y
    walkSpeed: 3.5,    // ground wander speed, units/s
    swimSpeed: 2.5,    // paddling speed — deliberately slower than the fish
    flySpeed: 11,      // cruise speed in flight
    maxWade: 0.4,      // deeper than this and it's swimming
    lookAhead: 4,      // walking obstacle probe distance
    turnNoise: 1.2,    // walking wander, radians/s
    walkFlightMin: 6,  // seconds on land between flights
    walkFlightMax: 16,
    swimFlightMin: 4,  // birds get impatient on water sooner
    swimFlightMax: 10,
    flightDurMin: 5,   // how long a flight lasts before it seeks a landing
    flightDurMax: 14,
    altMin: 3,         // altitude band above the local surface
    altMax: 35,        //   ... up to properly high
    altDrift: 18,      // how fast the altitude target wanders, units/s
    maxTurn: 1.2,      // cap on wander turn rate, rad/s
    loopChance: 0.25,  // probability per second of committing to a full loop
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
