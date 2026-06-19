import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from '../config/world.js';

/* ============================================================
 * TABLE OF CONTENTS — sections appear in this order, each under
 * a banner comment matching the name below. Search for the
 * banner (e.g. "* SCULPTING") to jump to a section.
 *
 *   1  CONFIG       central knobs for the whole scene
 *   2  RENDERER
 *   3  SCENE        background + fog
 *   4  CAMERA
 *   5  CONTROLS     OrbitControls + mouse-button policy
 *   6  LIGHTS
 *   7  PLATFORM     the rectangular slab (top face at y = 0)
 *   8  FENCE        wooden border wall around the perimeter
 *   9  TERRAIN      heightfield over the platform top
 *  10  SCULPTING    raise/lower/smooth brushes + bindSlider helper
 *  11  WATER        translucent volume, level slider
 *  12  FISH         aquatic population (+ shared agent helpers:
 *                   createAgent, dropFromAbove, maturationStep,
 *                   layStep, SPECIES registry)
 *  13  EGGS         lay -> fertilize -> incubate -> hatch
 *  14  VEGETATION   instanced-sphere plants, food reserve
 *  15  GRAZING      hunger-driven plant seeking (all species)
 *  16  FROG         land population
 *  17  FLIERS       bird / insect / bigbird
 *  18  HUNGER       reserves, hunger bars, starvation
 *  19  CREATURE PLACEMENT   dropdown + Place tool
 *  20  POPULATION LOG + CHART
 *  21  VIEW SNAPPING        camera presets
 *  23  READOUT + RESIZE
 *  24  LOOP         animate() + startup spawns
 * ============================================================ */

/* ============================================================
 * CONFIG  —  central knobs for the whole scene
 * ============================================================ */

/* ============================================================
 * SETUP — pre-simulation world parameters
 *
 * The world's width, length, height and grid resolution are
 * structural: sized arrays, fixed chunk geometry, and the brush
 * GLSL all bake them in at construction. So the setup menu applies
 * its choices by writing them to the URL hash and reloading once;
 * this block reads the hash BEFORE any size-dependent construction
 * runs and patches CONFIG in place (P and T are references, so the
 * downstream consts pick up the new values). `go=1` in the hash
 * means "a world was configured — build and run it"; its absence
 * means "show the setup menu first".
 * ============================================================ */
const SETUP_PARAMS = new URLSearchParams(location.hash.slice(1));

/* Device profile: phones/tablets get a cheaper renderer and a smaller default
 * world. Coarse pointer is the most reliable signal; UA is a fallback. */
const IS_MOBILE = (window.matchMedia && matchMedia('(pointer: coarse)').matches)
  || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
const PERF = IS_MOBILE ? {
  pixelRatio: Math.min(window.devicePixelRatio || 1, 1.25), // biggest single win: ~2-4x fewer pixels
  antialias: false,            // MSAA is expensive on mobile GPUs
  shadowType: 'basic',         // unfiltered shadows: cheapest pass
  shadowMapSize: 1024,         // vs 4096 on desktop (16x fewer shadow texels)
  maxSubsteps: 8,              // cap CPU work at high time scales
  defaultWorld: { w: 240, l: 160 }, // quarter the cells of the desktop default
} : {
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  antialias: true,
  shadowType: 'soft',
  shadowMapSize: 4096,
  maxSubsteps: 20,
  defaultWorld: null,
};

/* Advanced world-gen knobs surfaced on the setup screen. Data-driven so the
 * UI, the hash round-trip, and the CONFIG.terrain patch all stay in sync from
 * one list. Each knob's default comes from CONFIG.terrain (config/world.js);
 * the setup screen can override it, and the override rides the same hash→reload
 * path as the structural dials. `dp` = decimal places for the value readout. */
const TERRAIN_KNOB_GROUPS = [
  { title: 'Noise & shape', knobs: [
    { key: 'octaves',      label: 'octaves',        min: 1,   max: 8,   step: 1,    dp: 0, tip: 'Number of noise detail layers summed together. More octaves add finer ridges and roughness but cost a little more to generate; fewer give smoother, simpler landforms.' },
    { key: 'lacunarity',   label: 'lacunarity',     min: 1.5, max: 3,   step: 0.05, dp: 2, tip: 'How much the frequency jumps between each octave. Around 2.0 looks natural; higher values pack in more small-scale detail per layer.' },
    { key: 'persistence',  label: 'persistence',    min: 0.2, max: 0.8, step: 0.01, dp: 2, tip: 'How much each finer octave contributes to the total height. Higher makes terrain rougher and noisier; lower yields smooth, rolling hills.' },
    { key: 'warpStrength', label: 'domain warp',    min: 0,   max: 2,   step: 0.05, dp: 2, tip: 'Bends the noise coordinates with more noise so valleys meander and ridges swirl. 0 leaves it geometric; higher gives a more organic, water-eroded look.' },
    { key: 'redistPow',    label: 'redistribution', min: 0.5, max: 5,   step: 0.1,  dp: 1, tip: 'Reshapes the elevation curve toward broad low ground with a few high peaks. 1 leaves it linear; raise it for flatter plains and more dramatic, isolated summits.' },
  ] },
  { title: 'Mountains & terraces', knobs: [
    { key: 'ridgeMix',        label: 'ridge mix',        min: 0, max: 1,  step: 0.05, dp: 2, tip: 'Blends sharp, creased ridgelines into the higher elevations so they read as mountain ranges. 0 keeps everything rounded; 1 gives full alpine ridges.' },
    { key: 'terraceLevels',   label: 'terrace levels',   min: 0, max: 16, step: 1,    dp: 0, tip: 'Number of flat stepped bands cut into the elevation, like rice terraces or mesas. Set to 0 to disable terracing entirely.' },
    { key: 'terraceStrength', label: 'terrace strength', min: 0, max: 1,  step: 0.05, dp: 2, tip: 'How hard the terrain snaps onto those terrace steps. 0 stays smooth; 1 produces crisp, flat plateaus with steep risers.' },
  ] },
  { title: 'Coastline', knobs: [
    { key: 'coastStart',  label: 'coast start',    min: 0.2, max: 0.95, step: 0.01,  dp: 2, tip: 'Radius at which the island begins sloping down to the sea (0 is the center, 1 the map edge). Lower values shrink the landmass and leave more open water around it.' },
    { key: 'coastWobble', label: 'coast wobble',   min: 0,   max: 0.4,  step: 0.01,  dp: 2, tip: 'Adds noise to the shoreline so it forms bays, inlets and peninsulas. 0 gives a smooth geometric coast; higher makes a more ragged, natural outline.' },
    { key: 'seaBias',     label: 'sea-level bias', min: 0,   max: 0.3,  step: 0.005, dp: 3, tip: 'Lowers the whole landmass relative to the water line. Raise it to flood more of the map, lower it to expose more dry land.' },
    { key: 'beachWidth',  label: 'beach width',    min: 0,   max: 6,    step: 0.25,  dp: 2, tip: 'Width of the flattened beach and shallow underwater shelf along the waterline. 0 gives a hard shore edge; larger values create gentle, wadeable shallows for fish and shore plants.' },
  ] },
  { title: 'Hydraulic erosion', knobs: [
    { key: 'erosionDroplets',       label: 'droplets',          min: 0, max: 200000, step: 5000,  dp: 0, tip: 'How many simulated rain droplets carve the terrain after the noise pass. More droplets dig deeper, more detailed river valleys but take longer to generate; 0 turns hydraulic erosion off.' },
    { key: 'erosionRadius',         label: 'erosion radius',    min: 1, max: 8,      step: 1,     dp: 0, tip: 'How wide a footprint each droplet erodes around its path. Larger radii carve broad, smooth valleys; smaller ones cut narrow, sharp channels.' },
    { key: 'inertia',               label: 'inertia',           min: 0, max: 0.9,    step: 0.05,  dp: 2, tip: 'How strongly droplets hold their heading versus turning straight downhill. Higher inertia makes straighter rivers; lower lets them hug every contour.' },
    { key: 'sedimentCapacityFactor',label: 'sediment capacity', min: 1, max: 12,     step: 0.5,   dp: 1, tip: 'How much eroded material fast-flowing water can carry before dropping it. Higher values dig more aggressively and build larger sediment deposits.' },
    { key: 'minSedimentCapacity',   label: 'min capacity',      min: 0, max: 0.05,   step: 0.005, dp: 3, tip: 'A floor on carrying capacity so even slow water erodes a little. Without it, flat or gentle areas would never gain any river detail.' },
    { key: 'erodeSpeed',            label: 'erode speed',       min: 0, max: 1,      step: 0.05,  dp: 2, tip: 'How quickly each droplet removes material from the terrain. Higher carves faster and sharper; lower gives subtler, gentler erosion.' },
    { key: 'depositSpeed',          label: 'deposit speed',     min: 0, max: 1,      step: 0.05,  dp: 2, tip: 'How quickly droplets lay sediment back down when they slow or pool. Higher builds more pronounced fans, deltas and flat valley floors.' },
    { key: 'evaporateSpeed',        label: 'evaporate',         min: 0, max: 0.1,    step: 0.005, dp: 3, tip: 'How fast a droplet shrinks and dies as it travels. Higher evaporation makes shorter rivers; lower lets them run much farther.' },
    { key: 'gravity',               label: 'gravity',           min: 1, max: 20,     step: 0.5,   dp: 1, tip: 'How strongly downhill slope accelerates the droplets. Higher gravity means faster flow and stronger erosion on steep ground.' },
    { key: 'maxDropletLifetime',    label: 'droplet life',      min: 5, max: 80,     step: 5,     dp: 0, tip: 'The most steps a single droplet can travel before it stops. Higher lets rivers reach across the whole map; lower keeps erosion local.' },
  ] },
  { title: 'Thermal erosion', knobs: [
    { key: 'thermalIterations', label: 'iterations',   min: 0,   max: 40, step: 1,    dp: 0, tip: 'How many passes slump over-steep slopes into stable scree. More passes smooth cliffs and erosion scars; 0 skips thermal erosion.' },
    { key: 'thermalTalus',      label: 'talus angle',  min: 0.1, max: 3,  step: 0.1,  dp: 1, tip: 'The steepest slope that can stay put before material slides down. Lower values smooth everything more; higher keeps sharp cliffs intact.' },
    { key: 'thermalFactor',     label: 'talus factor', min: 0,   max: 1,  step: 0.05, dp: 2, tip: 'How much of the excess steepness is moved on each thermal pass. Higher smooths faster but can wash out fine detail.' },
  ] },
];
const TERRAIN_KNOBS = TERRAIN_KNOB_GROUPS.flatMap(g => g.knobs);

/* One-click world archetypes shown on the setup screen. Clicking one resets all
 * terrain knobs to their config/world.js defaults, then layers on `terrain`
 * overrides; `amp`/`water` drive the basic sliders. Tuned against the default
 * 480×320 / height-20 world. */
const TERRAIN_PRESETS = [
  { label: 'Continent', tip: 'One large, contiguous landmass with gentle interior relief and a broad, smooth coastline.',
    amp: 10, water: 2.5,
    terrain: { coastStart: 0.82, coastWobble: 0.10, seaBias: 0.02, redistPow: 1.8, ridgeMix: 0.30, warpStrength: 0.5 } },
  { label: 'Few large islands', tip: 'A handful of big islands separated by generous channels of open water.',
    amp: 11, water: 3.5,
    terrain: { coastStart: 0.55, coastWobble: 0.20, seaBias: 0.10, redistPow: 2.2, ridgeMix: 0.40 } },
  { label: 'Archipelago', tip: 'Many small, scattered islands and islets ringed by shallow water.',
    amp: 11, water: 4,
    terrain: { coastStart: 0.45, coastWobble: 0.32, seaBias: 0.16, redistPow: 2.6, ridgeMix: 0.35, persistence: 0.58, octaves: 7, warpStrength: 0.8, beachWidth: 2.5 } },
  { label: 'Mountain range', tip: 'High, sharply ridged peaks with deep, water-carved valleys across the interior.',
    amp: 18, water: 2,
    terrain: { coastStart: 0.80, coastWobble: 0.10, seaBias: 0.02, ridgeMix: 0.95, redistPow: 3.5, warpStrength: 0.9, octaves: 7, persistence: 0.55, erosionDroplets: 120000, erodeSpeed: 0.40, thermalIterations: 12 } },
  { label: 'Rolling hills', tip: 'Soft, smooth hills and wide plains — a calm, pastoral world with little water.',
    amp: 8, water: 2.5,
    terrain: { coastStart: 0.80, coastWobble: 0.12, seaBias: 0.03, ridgeMix: 0.0, redistPow: 1.4, persistence: 0.42, octaves: 5, warpStrength: 0.4, erosionDroplets: 40000, thermalIterations: 14 } },
  { label: 'Canyon mesas', tip: 'Stepped plateaus and flat-topped mesas carved into deep channels by erosion.',
    amp: 14, water: 2,
    terrain: { coastStart: 0.78, coastWobble: 0.10, seaBias: 0.03, ridgeMix: 0.30, redistPow: 2.2, terraceLevels: 8, terraceStrength: 0.55, erosionDroplets: 110000, erodeSpeed: 0.40, thermalIterations: 4, warpStrength: 0.7 } },
  { label: 'Ocean', tip: 'Open water broken only by a few small specks of low-lying land.',
    amp: 9, water: 6,
    terrain: { coastStart: 0.35, coastWobble: 0.25, seaBias: 0.22, redistPow: 2.6, ridgeMix: 0.30 } },
];

const SETUP = {
  width:      clampNum(SETUP_PARAMS.get('w'),   4, Infinity, CONFIG.platform.width),
  length:     clampNum(SETUP_PARAMS.get('l'),   4, Infinity, CONFIG.platform.depth),
  height:     clampNum(SETUP_PARAMS.get('h'),   0, Infinity, 20), // world vertical extent
  amplitude:  clampNum(SETUP_PARAMS.get('amp'), 0, Infinity, 12),
  water:      clampNum(SETUP_PARAMS.get('water'), 0, Infinity, 3),
  vegetation: clampNum(SETUP_PARAMS.get('veg'), 0, 1.5, 1),
  go:         SETUP_PARAMS.get('go') === '1',
};
SETUP.amplitude = Math.min(SETUP.amplitude, SETUP.height); // peaks can't exceed the walls
SETUP.water     = Math.min(SETUP.water, SETUP.height);     // independent, but bounded by the walls
function clampNum(raw, lo, hi, dflt) {
  const v = parseFloat(raw);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

// Snapshot the config/world.js defaults BEFORE applying any hash overrides, so
// the setup screen's "reset" can restore them.
const DEFAULT_TERRAIN = {};
for (const k of TERRAIN_KNOBS) DEFAULT_TERRAIN[k.key] = CONFIG.terrain[k.key];
// Patch CONFIG.terrain in place from any advanced knobs present in the hash, so
// generateIsland picks them up. These are non-structural (no array resize), so
// no rebuild is needed beyond the single reload the setup screen already does.
for (const k of TERRAIN_KNOBS) {
  const v = clampNum(SETUP_PARAMS.get(k.key), k.min, k.max, NaN);
  if (Number.isFinite(v)) CONFIG.terrain[k.key] = v;
}

// Structural params -> CONFIG, before the size-dependent consts are built.
// On mobile, first open (no explicit dimensions) defaults to a smaller world.
if (PERF.defaultWorld && !SETUP_PARAMS.has('w')) {
  SETUP.width = PERF.defaultWorld.w;
  SETUP.length = PERF.defaultWorld.l;
}
// Grid resolution tracks size at 1 cell/unit (rounded), preserving brush feel.
// NOTE: platform.height is the (fixed, thin) slab thickness below the datum;
// the world's vertical extent is `worldHeight` below, which drives wall height
// and the terrain amplitude ceiling at runtime (no rebuild needed).
CONFIG.platform.width  = SETUP.width;
CONFIG.platform.depth  = SETUP.length;
CONFIG.terrain.segX    = Math.round(SETUP.width);
CONFIG.terrain.segZ    = Math.round(SETUP.length);

// Non-structural initial values, consumed during the startup sequence.
let worldHeight = SETUP.height;  // wall height AND max terrain amplitude (ceiling)
let vegLevel = SETUP.vegetation; // density multiplier in vegDensityAt


/* Convenience: a single point the camera aims at (centre of platform top). */
const FOCUS = new THREE.Vector3(0, 0, 0);

/* ============================================================
 * RENDERER
 * ============================================================ */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: PERF.antialias });
renderer.setPixelRatio(PERF.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PERF.shadowType === 'soft' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
app.appendChild(renderer.domElement);

/* ============================================================
 * SCENE  +  atmosphere
 * ============================================================ */
const scene = new THREE.Scene();
const css = getComputedStyle(document.documentElement);
const bg0 = new THREE.Color(css.getPropertyValue('--bg-0').trim());
const bg1 = new THREE.Color(css.getPropertyValue('--bg-1').trim());
scene.background = bg0;
scene.fog = new THREE.Fog(bg0, 60, 160);

/* ============================================================
 * CAMERA
 * ============================================================ */
const camera = new THREE.PerspectiveCamera(
  CONFIG.camera.fov,
  window.innerWidth / window.innerHeight,
  CONFIG.camera.near,
  CONFIG.camera.far
);

/* Horizontal-FOV lock. Three's camera.fov is the VERTICAL field of view, so a
 * narrow window crops the sides and the lateral framing drifts with width. We
 * instead treat the configured fov as a vertical fov at a reference aspect, then
 * derive the actual vertical fov from the live aspect so the HORIZONTAL field of
 * view stays constant — the lateral view is identical at any browser width. */
const FOV_REF_ASPECT = 16 / 9;     // aspect at which a configured fov reads as-is
let designFov = CONFIG.camera.fov; // intended vertical fov (at the reference aspect)
function fovForAspect(vfovDeg, aspect) {
  const hFov = 2 * Math.atan(Math.tan(vfovDeg * Math.PI / 180 / 2) * FOV_REF_ASPECT);
  return 2 * Math.atan(Math.tan(hFov / 2) / aspect) * 180 / Math.PI;
}
function applyFov() {
  camera.fov = fovForAspect(designFov, camera.aspect);
  camera.updateProjectionMatrix();
}
applyFov(); // seat the initial fov for the starting aspect

/* Bounding radius of the platform footprint — used to frame snap views. */
const P = CONFIG.platform;
const boundRadius = 0.5 * Math.hypot(P.width, P.depth);
const R = boundRadius * CONFIG.camera.fit;

/* Scale adaptation: clip planes and fog follow the platform size, so the
 * scene frames correctly whether the platform is 24 units or 2400. */
camera.far = Math.max(CONFIG.camera.far, R * 8);
camera.updateProjectionMatrix();
scene.fog.near = R * 2.2;
scene.fog.far  = R * 6;
const fogNear = scene.fog.near;
const fogFar  = scene.fog.far;
const underwaterColor = new THREE.Color(0x1a4a6a); // deep blue-green tint

/* ============================================================
 * CONTROLS
 * ============================================================ */
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
/* Left is reserved for painting; middle orbits, right pans, wheel zooms.
 * Alt-hold temporarily gives left-drag to orbit (trackpad fallback). */
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
/* Touch: one finger is reserved for the brush (mirrors left-click painting);
 * two fingers pinch-zoom and rotate the orbit. */
controls.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.minDistance = Math.max(2, R * 0.02);
controls.maxDistance = R * 3;
controls.maxPolarAngle = Math.PI * 0.495; // keep camera just above the ground plane
controls.target.copy(FOCUS);

/* ============================================================
 * LIGHTS
 * ============================================================ */
const hemi = new THREE.HemisphereLight(0xbcd0e0, 0x202830, 0.55);
scene.add(hemi);

const ambient = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff4e6, 1.15);
sun.position.set(R * 0.6, R * 0.9, R * 0.4);
sun.castShadow = true;
sun.shadow.mapSize.set(PERF.shadowMapSize, PERF.shadowMapSize);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = R * 4;
const s = Math.max(P.width, P.depth) * 0.9;
sun.shadow.camera.left   = -s;
sun.shadow.camera.right  =  s;
sun.shadow.camera.top    =  s;
sun.shadow.camera.bottom = -s;
sun.shadow.bias = -0.0004;
scene.add(sun);

/* ============================================================
 * PLATFORM  —  the rectangular slab (top face at y = 0)
 * ============================================================ */
const platformGroup = new THREE.Group();
scene.add(platformGroup);

const slabGeo = new THREE.BoxGeometry(P.width, P.height, P.depth);
const slabMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(css.getPropertyValue('--platform').trim()),
  roughness: 0.85,
  metalness: 0.0,
});
const slab = new THREE.Mesh(slabGeo, slabMat);
slab.position.y = -P.height / 2;     // push the slab down so its TOP sits at y = 0
slab.receiveShadow = true;
slab.castShadow = true;
platformGroup.add(slab);

/* Grid overlaid on the platform top, clipped to the footprint via a sized helper. */
if (CONFIG.grid.enabled) {
  const gridSize = Math.max(P.width, P.depth);
  const spacing = Math.max(1, Math.round(gridSize / 100)); // cap at ~100 lines per axis
  const grid = new THREE.GridHelper(
    gridSize,
    Math.round(gridSize / spacing),
    new THREE.Color(css.getPropertyValue('--grid-axis').trim()),
    new THREE.Color(css.getPropertyValue('--grid').trim())
  );
  grid.position.y = 0.002; // hair above the top face to avoid z-fighting
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  // Clip the (square) grid to the rectangular footprint.
  grid.scale.set(P.width / gridSize, 1, P.depth / gridSize);
  platformGroup.add(grid);
}

/* ============================================================
 * FENCE  —  transparent glass border wall around the platform
 *
 * Walls sit flush against the platform sides, rising to the
 * world height (the vertical extent) and extending down to
 * clad the slab. Independent of the water level.
 * ============================================================ */
const F = CONFIG.fence;
const fenceGroup = new THREE.Group();
platformGroup.add(fenceGroup);
const fenceWalls = [];
{
  const t = F.thickness;
  // Transparent glass: tinted, low-opacity, smooth, double-sided so the inner
  // face reads too. depthWrite off + high renderOrder so the scene shows
  // through cleanly; glass doesn't cast shadow (transparent shadows would
  // render as solid dark slabs without a custom shadow material).
  const glassMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x9fd4e8),
    transparent: true,
    opacity: 0.16,
    roughness: 0.05,
    metalness: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  // [sizeX, sizeZ, posX, posZ] — long walls overlap the corners.
  const walls = [
    [P.width + 2 * t, t, 0, -(P.depth / 2 + t / 2)], // north
    [P.width + 2 * t, t, 0,  (P.depth / 2 + t / 2)], // south
    [t, P.depth, -(P.width / 2 + t / 2), 0],         // west
    [t, P.depth,  (P.width / 2 + t / 2), 0],         // east
  ];
  for (const [sx, sz, px, pz] of walls) {
    // Unit-height box, scaled live by setFenceHeight.
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, 1, sz), glassMat);
    wall.position.set(px, 0, pz);
    wall.renderOrder = 2;       // draw after opaque geometry for correct blending
    wall.castShadow = false;
    wall.receiveShadow = false;
    fenceGroup.add(wall);
    fenceWalls.push({ wall });
  }
}

/* Walls rise to `worldHeight` above the datum (set once at build, and on
 * "New world"); they always extend down past the datum to clad the slab.
 * Wall height is the world's vertical extent — independent of the water
 * level, which fills the basin separately. */
function setFenceHeight(top) {
  const H = Math.max(0.05, top + P.height); // spans slab bottom .. top
  for (const { wall } of fenceWalls) {
    wall.scale.y = H;
    wall.position.y = top - H / 2;
  }
}
setFenceHeight(worldHeight);

/* ============================================================
 * TERRAIN  —  heightfield over the platform top
 *
 * `heights` is the single source of truth (grid-indexed iz*NX+ix).
 * Water, vegetation, and agents will all sample this array later.
 * ============================================================ */
const T = CONFIG.terrain;
const NX = T.segX + 1, NZ = T.segZ + 1;
const heights = new Float32Array(NX * NZ);
const dx = P.width / T.segX, dz = P.depth / T.segZ;

/* Brush-ring uniforms, injected into the terrain shader below so the
 * cursor indicator conforms exactly to the sculpted surface. */
const brushUniforms = {
  uBrushPos:    { value: new THREE.Vector3() },
  uBrushRadius: { value: 3 },
  uBrushOn:     { value: 0 },
};

/* Egg-laying zone: a painted per-cell mask, shown as a tint on the
 * terrain via a DataTexture, and consumed by the fish flow field. */
const zoneMask = new Uint8Array(NX * NZ); // 0 or 255
let zoneCellCount = 0;
const zoneTex = new THREE.DataTexture(zoneMask, NX, NZ, THREE.RedFormat, THREE.UnsignedByteType);
zoneTex.minFilter = zoneTex.magFilter = THREE.LinearFilter;
zoneTex.needsUpdate = true;
const zoneUniforms = { uZoneTex: { value: zoneTex } };

/* Soil carrying capacity: a coarse patch grid where each patch caps how many
 * calories of plant matter it can support. `soilCap` is the painted capacity
 * (calories), `soilLoad` the current biomass (Σ plant food, recomputed each
 * soil pass). A normalized Uint8 copy (`soilTexData`) drives a fertility tint
 * shown while the Soil brush is active. Granularity is CONFIG.soil.patch units,
 * coarser than the heightfield so a single plant's biomass reads stably. */
const SOIL = CONFIG.soil;
const SPX = Math.max(1, Math.ceil(P.width / SOIL.patch));
const SPZ = Math.max(1, Math.ceil(P.depth / SOIL.patch));
const soilCap     = new Float32Array(SPX * SPZ).fill(SOIL.defaultCap);
const soilLoad    = new Float32Array(SPX * SPZ);
const soilTexData = new Uint8Array(SPX * SPZ).fill(Math.round(Math.min(1, SOIL.defaultCap / SOIL.maxCap) * 255));
const soilTex = new THREE.DataTexture(soilTexData, SPX, SPZ, THREE.RedFormat, THREE.UnsignedByteType);
// Linear so the always-on fertility GROUND COLOR blends smoothly between patches;
// the editing overlay re-snaps to patch centres in-shader to keep the grid crisp.
soilTex.minFilter = soilTex.magFilter = THREE.LinearFilter;
soilTex.needsUpdate = true;
const soilUniforms = { uSoilTex: { value: soilTex }, uSoilOn: { value: 0 } };
let soilAccum = 0; // sim-seconds since the last carrying-capacity pass

const soilPatchIndex = (x, z) => {
  const px = Math.min(SPX - 1, Math.max(0, ((x + P.width / 2) / SOIL.patch) | 0));
  const pz = Math.min(SPZ - 1, Math.max(0, ((z + P.depth / 2) / SOIL.patch) | 0));
  return pz * SPX + px;
};
// True if patch (x,z) can still take `food` more calories without exceeding cap.
const soilRoomFor = (x, z, food) => {
  const pi = soilPatchIndex(x, z);
  return soilLoad[pi] + food <= soilCap[pi];
};

/* Fish breeding flow field: BFS distance-to-nearest-zone over navigable
 * water. Declared here (before the water/fish sections that mark it
 * dirty during init); computed lazily in computeFlowField() at runtime. */
const flowDist = new Float32Array(NX * NZ);
let flowDirty = true, flowAccum = 0;
const markFlowDirty = () => { flowDirty = true; };

const terrainMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(css.getPropertyValue('--terrain').trim()),
  roughness: 0.95,
  metalness: 0.0,
});
terrainMat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, brushUniforms, zoneUniforms, soilUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vBrushWorld;')
    .replace('#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvBrushWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>',
      '#include <common>\nvarying vec3 vBrushWorld;\nuniform vec3 uBrushPos;\nuniform float uBrushRadius;\nuniform float uBrushOn;\nuniform sampler2D uZoneTex;\nuniform sampler2D uSoilTex;\nuniform float uSoilOn;')
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      {
        vec2 zUv = vBrushWorld.xz / vec2(${P.width.toFixed(1)}, ${P.depth.toFixed(1)}) + 0.5;

        // Egg-laying zone tint (sampled from the painted mask).
        float zone = texture2D(uZoneTex, zUv).r;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.36, 0.85, 0.55), zone * 0.4);

        // Soil carrying-capacity EDIT overlay (only while the Soil brush is
        // active): snap to patch centres for a crisp grid, yellow -> dark green.
        vec2 pUv = (floor(zUv * vec2(${SPX.toFixed(1)}, ${SPZ.toFixed(1)})) + 0.5) / vec2(${SPX.toFixed(1)}, ${SPZ.toFixed(1)});
        float soilCrisp = texture2D(uSoilTex, pUv).r;
        vec3 soilCol = mix(vec3(0.90, 0.84, 0.22), vec3(0.07, 0.30, 0.11), soilCrisp);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, soilCol, uSoilOn * 0.5);

        // Brush cursor ring.
        float d = distance(vBrushWorld.xz, uBrushPos.xz);
        float w = max(0.12, uBrushRadius * 0.045);
        float ring = (1.0 - smoothstep(uBrushRadius - w, uBrushRadius, d))
                   * smoothstep(uBrushRadius - 2.5 * w, uBrushRadius - w, d);
        float fill = (1.0 - smoothstep(0.0, uBrushRadius, d)) * 0.10;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.373, 0.702, 0.831), (ring * 0.85 + fill) * uBrushOn);
      }`);
};

/* ---- Chunked terrain mesh ----------------------------------
 * The heightfield stays ONE global array (single source of truth);
 * only the rendering is split into CHUNK x CHUNK-cell tiles:
 *   - a brush stroke rebuilds only the tiles it touches,
 *   - off-screen tiles frustum-cull automatically,
 *   - pointer raycasts reject whole tiles by bounding sphere,
 *   - and a future streaming world adds/removes entries in
 *     `terrainChunks` instead of resizing one giant mesh.
 * Border vertices are duplicated in adjacent tiles but read the same
 * global cell, so positions are exactly seam-free. */
const CHUNK = T.chunk;
const terrainChunks = [];
const terrainMeshes = []; // brush raycast targets
for (let ccz = 0; ccz * CHUNK < T.segZ; ccz++) {
  for (let ccx = 0; ccx * CHUNK < T.segX; ccx++) {
    const x0 = ccx * CHUNK, x1 = Math.min(T.segX, x0 + CHUNK);
    const z0 = ccz * CHUNK, z1 = Math.min(T.segZ, z0 + CHUNK);
    const w = (x1 - x0) * dx, d = (z1 - z0) * dz;
    const geo = new THREE.PlaneGeometry(w, d, x1 - x0, z1 - z0);
    geo.rotateX(-Math.PI / 2);
    geo.translate(-P.width / 2 + x0 * dx + w / 2, 0, -P.depth / 2 + z0 * dz + d / 2);
    const mesh = new THREE.Mesh(geo, terrainMat); // shared brush/zone material
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    platformGroup.add(mesh);

    /* Map each chunk vertex to its global (ix, iz) cell once, up front,
     * so refreshes never depend on PlaneGeometry's internal ordering. */
    const pos = geo.attributes.position;
    const v2g = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const ix = Math.round((pos.getX(i) + P.width / 2) / dx);
      const iz = Math.round((pos.getZ(i) + P.depth / 2) / dz);
      v2g[i] = iz * NX + ix;
    }
    terrainChunks.push({ geo, pos, nrm: geo.attributes.normal, v2g, x0, x1, z0, z1 });
    terrainMeshes.push(mesh);
  }
}

/* Rebuild one chunk's heights + normals from the global array. Normals are
 * analytic central differences on `heights` — reading the global array (not
 * per-chunk geometry) keeps lighting seamless across chunk borders, and it
 * replaces the far more expensive whole-mesh computeVertexNormals(). */
function refreshChunk(c) {
  const { pos, nrm, v2g } = c;
  for (let i = 0; i < pos.count; i++) {
    const g = v2g[i];
    const iz = (g / NX) | 0, ix = g - iz * NX;
    pos.setY(i, heights[g]);
    const xm = ix > 0 ? ix - 1 : ix, xp = ix < T.segX ? ix + 1 : ix; // one-sided at map edge
    const zm = iz > 0 ? iz - 1 : iz, zp = iz < T.segZ ? iz + 1 : iz;
    const sx = (heights[iz * NX + xp] - heights[iz * NX + xm]) / ((xp - xm) * dx);
    const sz = (heights[zp * NX + ix] - heights[zm * NX + ix]) / ((zp - zm) * dz);
    const inv = 1 / Math.hypot(sx, 1, sz);
    nrm.setXYZ(i, -sx * inv, inv, -sz * inv);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  c.geo.computeBoundingSphere(); // keeps raycasts + frustum culling honest as heights change
}

/* Refresh only chunks intersecting a cell-index region. The +1 halo matters:
 * editing a cell changes the *normals* of its neighbours, which may live in
 * the adjacent chunk. */
function refreshTerrainRegion(rx0, rz0, rx1, rz1) {
  rx0 -= 1; rz0 -= 1; rx1 += 1; rz1 += 1;
  for (const c of terrainChunks) {
    if (c.x1 < rx0 || c.x0 > rx1 || c.z1 < rz0 || c.z0 > rz1) continue;
    refreshChunk(c);
  }
}

function refreshTerrain() { // full rebuild (generate / flatten)
  for (const c of terrainChunks) refreshChunk(c);
}

/* Bilinear height sample at any world (x, z) — the collision/placement
 * primitive for fish, land agents, and vegetation rules. */
function sampleHeight(x, z) {
  const fx = Math.min(T.segX - 1e-6, Math.max(0, (x + P.width / 2) / dx));
  const fz = Math.min(T.segZ - 1e-6, Math.max(0, (z + P.depth / 2) / dz));
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const i00 = iz * NX + ix, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1;
  return (heights[i00] * (1 - tx) + heights[i10] * tx) * (1 - tz)
       + (heights[i01] * (1 - tx) + heights[i11] * tx) * tz;
}

/* ---- Procedural island: simplex fBm + domain warp × organic falloff,
 *      baked through hydraulic + thermal erosion ---- */
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* 2D simplex noise (Gustavson), output ~[-1,1]. Far fewer directional
 * artifacts than the old value noise — the single biggest realism win.
 * The permutation table is rebuilt from worldSeed on each generate so the
 * whole field is deterministic and seed-only (no per-cell RNG → no chunk
 * seams when streaming later). */
const _perm     = new Uint8Array(512);
const _permMod12 = new Uint8Array(512);
// 12 gradient directions (2D components of the classic grad3 set).
const _GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [1, 0], [-1, 0],
  [0, 1], [0, -1], [0, 1], [0, -1],
];
function buildPerm(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // seeded Fisher–Yates shuffle (mulberry32 PRNG)
  let s = (seed * 0x9e3779b1) >>> 0 || 1;
  const rng = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) { _perm[i] = p[i & 255]; _permMod12[i] = _perm[i] % 12; }
}
const _F2 = 0.5 * (Math.sqrt(3) - 1);
const _G2 = (3 - Math.sqrt(3)) / 6;
function snoise(xin, zin) {
  const s = (xin + zin) * _F2;
  const i = Math.floor(xin + s), j = Math.floor(zin + s);
  const t = (i + j) * _G2;
  const x0 = xin - (i - t), y0 = zin - (j - t);
  let i1, j1;
  if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
  const x1 = x0 - i1 + _G2,     y1 = y0 - j1 + _G2;
  const x2 = x0 - 1 + 2 * _G2,  y2 = y0 - 1 + 2 * _G2;
  const ii = i & 255, jj = j & 255;
  const gi0 = _permMod12[ii + _perm[jj]];
  const gi1 = _permMod12[ii + i1 + _perm[jj + j1]];
  const gi2 = _permMod12[ii + 1 + _perm[jj + 1]];
  let n0 = 0, n1 = 0, n2 = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * (_GRAD[gi0][0] * x0 + _GRAD[gi0][1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * (_GRAD[gi1][0] * x1 + _GRAD[gi1][1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * (_GRAD[gi2][0] * x2 + _GRAD[gi2][1] * y2); }
  return 70 * (n0 + n1 + n2); // ~[-1,1]
}

// fBm: octaves of simplex at doubling freq / halving amplitude → ~[-1,1].
function fbm(x, z, { octaves = T.octaves, lacunarity = T.lacunarity, gain = T.persistence } = {}) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum  += amp * snoise(x * freq, z * freq);
    norm += amp;
    amp  *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
// Ridged multifractal: creased ridgelines for mountain regions → ~[0,1].
function ridged(x, z, { octaves = T.octaves, lacunarity = T.lacunarity, gain = T.persistence } = {}) {
  let sum = 0, amp = 0.5, freq = 1, prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(snoise(x * freq, z * freq)); // crease at zero crossings
    n *= n;     // sharpen the ridge
    n *= prev;  // feedback: detail concentrates on existing ridges
    sum += n * amp; prev = n; freq *= lacunarity; amp *= gain;
  }
  return Math.min(1, sum);
}

/* Pure worldgen: terrain height at any world coordinate, independent of the
 * grid. This is the streaming seam — when the map later grows on demand,
 * newly created chunks call this with the same `worldSeed` and get terrain
 * that is deterministic and border-consistent with everything already built.
 * featureFreq is absolute (world units), so a larger map gets MORE coves and
 * hills to explore rather than the same three scaled up. */
let worldSeed = Math.random() * 1000;
let worldAmp = 3;
function terrainHeightAt(wx, wz) {
  const f = T.featureFreq;
  let x = wx * f, z = wz * f;

  // (5) Domain warp — distort the sample coords with noise before evaluating,
  // for meandering valleys and "eroded" structure without a sim. Strength is in
  // x-space (≈1 unit per feature wavelength), so keep warpStrength < 1.
  if (T.warpStrength > 0) {
    const qx = fbm(x, z);
    const qz = fbm(x + 5.2, z + 1.3);
    x += T.warpStrength * qx;
    z += T.warpStrength * qz;
  }

  // (3) Base fBm, remapped to [0,1].
  let e = fbm(x, z) * 0.5 + 0.5;

  // (4) Blend ridged noise into low-frequency mountain regions so ranges occur
  // in patches, not everywhere.
  if (T.ridgeMix > 0) {
    const mask = fbm(wx * f * 0.35 + 100, wz * f * 0.35 + 100) * 0.5 + 0.5;
    const m = sstep(0.5, 0.8, mask) * T.ridgeMix;
    if (m > 0) e = e * (1 - m) + ridged(x, z) * m;
  }

  // (6) Redistribution: pow(e,k) gives lots of low/flat land and few high peaks
  // — the key "terrain not hills" knob. Optional partial terracing for mesas.
  e = Math.pow(Math.max(0, e), T.redistPow);
  if (T.terraceLevels > 0 && T.terraceStrength > 0) {
    const stepped = Math.round(e * T.terraceLevels) / T.terraceLevels;
    e = e * (1 - T.terraceStrength) + stepped * T.terraceStrength;
  }

  // (7) Organic island mask: superellipse falloff with the rim perturbed by
  // low-freq noise → believable bays/peninsulas instead of a geometric ellipse.
  const u = wx / (P.width / 2), v = wz / (P.depth / 2);
  const d = Math.pow(Math.abs(u) ** 4 + Math.abs(v) ** 4, 0.25);
  const wobble = T.coastWobble * fbm(u * 2.2 + 55, v * 2.2 + 55);
  const falloff = 1 - sstep(T.coastStart, 1.0, d + wobble);

  // Subtract a sea-level bias so coastline forms where elevation·mask crosses 0.
  // worldHeight is the ceiling: terrain can't rise above the walls.
  return Math.min(worldHeight, Math.max(0, e * falloff - T.seaBias) * worldAmp * 1.4);
}

/* ---- Erosion bakes (whole-grid, stateful — NOT per-cell, so they live here
 *      in generateIsland, never in the analytic terrainHeightAt seam) ---- */

// Precompute a radial brush (relative cell offsets + normalized weights) used to
// spread each droplet's erosion over a small footprint instead of a single cell.
function makeErosionBrush(radius) {
  const r = Math.max(1, radius | 0);
  const offs = [];
  let wsum = 0;
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.hypot(dx, dz);
      if (dist > r) continue;
      const w = 1 - dist / r;
      offs.push(dx, dz, w);
      wsum += w;
    }
  for (let i = 2; i < offs.length; i += 3) offs[i] /= wsum;
  return offs; // flat [dx,dz,w, dx,dz,w, ...]
}

// (8) Droplet hydraulic erosion — rain that flows downhill, erodes where fast,
// deposits where it slows/turns uphill. Carves dendritic valleys + sediment
// fans that noise alone can't. Defaults follow Sebastian Lague's Erosion.cs.
function hydraulicErode() {
  const w = NX, h = NZ, T2 = T;
  const brush = makeErosionBrush(T2.erosionRadius);
  for (let drop = 0; drop < T2.erosionDroplets; drop++) {
    let px = Math.random() * (w - 1), pz = Math.random() * (h - 1);
    let dx = 0, dz = 0, speed = 1, water = 1, sediment = 0;
    for (let life = 0; life < T2.maxDropletLifetime; life++) {
      const nx = px | 0, nz = pz | 0;
      const ox = px - nx, oz = pz - nz;
      const i = nz * w + nx;
      const hNW = heights[i], hNE = heights[i + 1], hSW = heights[i + w], hSE = heights[i + w + 1];
      // bilinear height + gradient at the droplet
      const gradX = (hNE - hNW) * (1 - oz) + (hSE - hSW) * oz;
      const gradZ = (hSW - hNW) * (1 - ox) + (hSE - hNE) * ox;
      const hCur = hNW * (1 - ox) * (1 - oz) + hNE * ox * (1 - oz)
                 + hSW * (1 - ox) * oz       + hSE * ox * oz;
      // steer: blend momentum (inertia) with the downhill gradient
      dx = dx * T2.inertia - gradX * (1 - T2.inertia);
      dz = dz * T2.inertia - gradZ * (1 - T2.inertia);
      const len = Math.hypot(dx, dz);
      if (len !== 0) { dx /= len; dz /= len; }
      px += dx; pz += dz;
      if ((dx === 0 && dz === 0) || px < 0 || px >= w - 1 || pz < 0 || pz >= h - 1) break;
      // height at the new position
      const mx = px | 0, mz = pz | 0, mox = px - mx, moz = pz - mz, mi = mz * w + mx;
      const hNew = heights[mi] * (1 - mox) * (1 - moz) + heights[mi + 1] * mox * (1 - moz)
                 + heights[mi + w] * (1 - mox) * moz   + heights[mi + w + 1] * mox * moz;
      const dh = hNew - hCur;
      const capacity = Math.max(-dh * speed * water * T2.sedimentCapacityFactor, T2.minSedimentCapacity);
      if (sediment > capacity || dh > 0) {
        // deposit (carrying too much, or flowing uphill) onto the OLD cell
        const amt = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * T2.depositSpeed;
        sediment -= amt;
        heights[i]         += amt * (1 - ox) * (1 - oz);
        heights[i + 1]     += amt * ox * (1 - oz);
        heights[i + w]     += amt * (1 - ox) * oz;
        heights[i + w + 1] += amt * ox * oz;
      } else {
        // erode, spread over the brush; never dig a cell below the sea floor (0)
        const amt = Math.min((capacity - sediment) * T2.erodeSpeed, -dh);
        let removed = 0;
        for (let b = 0; b < brush.length; b += 3) {
          const bx = nx + brush[b], bz = nz + brush[b + 1];
          if (bx < 0 || bx >= w || bz < 0 || bz >= h) continue;
          const bi = bz * w + bx;
          const take = Math.min(heights[bi], amt * brush[b + 2]);
          heights[bi] -= take; removed += take;
        }
        sediment += removed;
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * T2.gravity));
      water *= (1 - T2.evaporateSpeed);
    }
  }
}

// (9) Thermal erosion — wherever a slope exceeds the talus angle, slump material
// downhill until stable. Softens noisy cliffs and erosion scars into scree.
function thermalErode() {
  const w = NX, h = NZ, talus = T.thermalTalus, factor = T.thermalFactor;
  const nb = [-1, 1, -w, w];
  for (let it = 0; it < T.thermalIterations; it++) {
    for (let z = 1; z < h - 1; z++) for (let x = 1; x < w - 1; x++) {
      const i = z * w + x, hc = heights[i];
      let dmax = 0, dsum = 0;
      for (let k = 0; k < 4; k++) { const dd = hc - heights[i + nb[k]]; if (dd > talus) { dsum += dd; if (dd > dmax) dmax = dd; } }
      if (dsum === 0) continue;
      const moved = factor * (dmax - talus);
      for (let k = 0; k < 4; k++) { const dd = hc - heights[i + nb[k]]; if (dd > talus) heights[i + nb[k]] += moved * (dd / dsum); }
      heights[i] -= moved;
    }
  }
}

// (10) Shore shelf — pull near-waterline cells toward the water level so the
// coast reads as a gentle beach + shallow underwater shelf (feeds waterDepthAt,
// fish/aquatic-plant placement) instead of a hard noise edge.
function shoreShelf() {
  const width = T.beachWidth;
  if (width <= 0) return;
  const lvl = water.level;
  for (let i = 0; i < heights.length; i++) {
    const band = Math.abs(heights[i] - lvl);
    if (band < width) {
      const t = sstep(0, width, band);
      heights[i] = lvl * (1 - t) + heights[i] * t;
    }
  }
}

function generateIsland() {
  worldAmp  = parseFloat(document.getElementById('island-amp').value);
  worldSeed = Math.random() * 1000;
  buildPerm(worldSeed); // reseed the simplex permutation table for this world
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      heights[iz * NX + ix] = terrainHeightAt(-P.width / 2 + ix * dx, -P.depth / 2 + iz * dz);
    }
  }
  // Whole-grid bakes, in order: carve (hydraulic) → settle (thermal) → beach.
  if (T.erosionDroplets   > 0) hydraulicErode();
  if (T.thermalIterations > 0) thermalErode();
  shoreShelf();
  // Erosion/thermal can push cells past the ceiling or below the floor; reclamp.
  for (let i = 0; i < heights.length; i++) heights[i] = Math.min(worldHeight, Math.max(0, heights[i]));
  refreshTerrain();
  markFlowDirty();
  generateVegetation(); // shore-weighted plant layer follows the new coastline
}

function flattenTerrain() {
  heights.fill(0);
  refreshTerrain();
  for (const pl of plants) pl.settle = true; // every plant re-seats to the flat surface
  markFlowDirty();
}

/* Terrain surface normal via central differences — used to seat
 * grounded agents (and later, slope rules for vegetation). */
const _normal = new THREE.Vector3();
function terrainNormalAt(x, z) {
  const e = Math.max(dx, dz);
  const hx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
  const hz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
  return _normal.set(-hx, 1, -hz).normalize();
}

/* ============================================================
 * SCULPTING  —  raise / lower / smooth brushes
 * ============================================================ */
const brush = {
  mode: 'raise',      // raise | lower | smooth — a tool is always active
  radius: 3,
  strength: 0.5,
  painting: false,
  needRecast: false,  // recast the brush ray only when the pointer moved
  hit: null,          // THREE.Vector3 | null
  ndc: new THREE.Vector2(),
  alt: false,
  shift: false,
};
const raycaster = new THREE.Raycaster();
const _smoothScratch = new Float32Array(NX * NZ); // smooth-brush snapshot (region-copied per stroke)

function setBrushMode(m) {
  brush.mode = m;
  document.querySelectorAll('#terrain-panel [data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === m)
  );
  document.getElementById('r-mode').textContent = m;
  brushUniforms.uBrushRadius.value = effectiveRingRadius(); // plant tool has its own radius
  soilUniforms.uSoilOn.value = (m === 'soil') ? 1 : 0;       // fertility tint only while painting soil
  const soilRow = document.getElementById('r-soil-row');
  if (soilRow) soilRow.style.display = (m === 'soil') ? '' : 'none';
  const soilCapRow = document.getElementById('soil-cap-row');
  if (soilCapRow) soilCapRow.style.display = (m === 'soil') ? '' : 'none';
  brush.needRecast = true;
}

/* Left-drag always paints; holding Alt hands left-drag to orbit
 * (for trackpads without a middle button). */
function syncControlButtons() {
  controls.mouseButtons.LEFT = brush.alt ? THREE.MOUSE.ROTATE : -1;
  renderer.domElement.style.cursor = brush.alt ? '' : 'crosshair';
}
syncControlButtons();

function castBrush() {
  raycaster.setFromCamera(brush.ndc, camera);
  const hit = raycaster.intersectObjects(terrainMeshes, false)[0];
  if (hit && !brush.alt) {
    brush.hit = hit.point;
    brushUniforms.uBrushPos.value.copy(hit.point);
    brushUniforms.uBrushOn.value = 1;
  } else {
    brush.hit = null;
    brushUniforms.uBrushOn.value = 0;
  }
}

function applyBrush(dt) {
  if (!brush.hit) return;
  const cx = brush.hit.x, cz = brush.hit.z;

  // Plant tool sprays vegetation within its own radius (no terrain edit).
  if (brush.mode === 'plant') {
    sprayPlants(cx, cz);
    return;
  }

  const rad = brush.radius;

  // Shift inverts raise <-> lower for sculpting, and erases for the zone.
  let m = brush.mode;
  if (brush.shift) m = m === 'raise' ? 'lower' : m === 'lower' ? 'raise' : m;

  const ix0 = Math.max(0, Math.floor((cx - rad + P.width / 2) / dx));
  const ix1 = Math.min(T.segX, Math.ceil((cx + rad + P.width / 2) / dx));
  const iz0 = Math.max(0, Math.floor((cz - rad + P.depth / 2) / dz));
  const iz1 = Math.min(T.segZ, Math.ceil((cz + rad + P.depth / 2) / dz));

  // Zone painting: a flat binary stamp (shift to erase), no falloff.
  if (m === 'zone') {
    const val = brush.shift ? 0 : 255;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = -P.width / 2 + ix * dx, wz = -P.depth / 2 + iz * dz;
        if (Math.hypot(wx - cx, wz - cz) > rad) continue;
        const idx = iz * NX + ix;
        if (zoneMask[idx] !== val) {
          zoneCellCount += val ? 1 : -1;
          zoneMask[idx] = val;
        }
      }
    }
    zoneTex.needsUpdate = true;
    markFlowDirty();
    return;
  }

  // Soil capacity painting: STAMP every covered patch to the brush's fixed
  // capacity value (Shift stamps 0 = barren). A flat set, not a nudge, so a
  // patch always reads exactly the value you painted. Edits the coarse
  // soil-patch grid, not the heightfield.
  if (m === 'soil') {
    const target = brush.shift ? 0 : soilBrush.value;
    const tex = Math.round(Math.min(1, target / SOIL.maxCap) * 255);
    const ps = SOIL.patch;
    const px0 = Math.max(0, Math.floor((cx - rad + P.width / 2) / ps));
    const px1 = Math.min(SPX - 1, Math.floor((cx + rad + P.width / 2) / ps));
    const pz0 = Math.max(0, Math.floor((cz - rad + P.depth / 2) / ps));
    const pz1 = Math.min(SPZ - 1, Math.floor((cz + rad + P.depth / 2) / ps));
    for (let pz = pz0; pz <= pz1; pz++) {
      for (let px = px0; px <= px1; px++) {
        const wx = -P.width / 2 + (px + 0.5) * ps, wz = -P.depth / 2 + (pz + 0.5) * ps;
        if (Math.hypot(wx - cx, wz - cz) > rad) continue; // patch centre inside the brush disc
        const pi = pz * SPX + px;
        soilCap[pi] = target;
        soilTexData[pi] = tex;
      }
    }
    soilTex.needsUpdate = true;
    grassDirty = true; // rebuild grass to match the new capacity when the stroke ends
    return;
  }

  /* Smoothing reads neighbours from a snapshot so the pass is unbiased.
   * The snapshot is a persistent scratch buffer and only the brush AABB
   * (+1 halo for the neighbour reads) is copied — heights.slice() here
   * was a full-map allocation+copy on every painting frame. */
  let src = null;
  if (m === 'smooth') {
    const xa = Math.max(0, ix0 - 1), xb = Math.min(T.segX, ix1 + 1);
    const za = Math.max(0, iz0 - 1), zb = Math.min(T.segZ, iz1 + 1);
    for (let iz = za; iz <= zb; iz++) {
      const s = iz * NX + xa;
      _smoothScratch.set(heights.subarray(s, iz * NX + xb + 1), s);
    }
    src = _smoothScratch;
  }
  const step = brush.strength * T.brushSpeed * dt;

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const wx = -P.width / 2 + ix * dx;
      const wz = -P.depth / 2 + iz * dz;
      const d = Math.hypot(wx - cx, wz - cz);
      if (d > rad) continue;
      const f = 0.5 * (1 + Math.cos(Math.PI * d / rad)); // cosine falloff
      const idx = iz * NX + ix;

      if (m === 'raise') {
        heights[idx] += step * f; // no ceiling — paint as high as you like
      } else if (m === 'lower') {
        heights[idx] = Math.max(0, heights[idx] - step * f);
      } else if (m === 'smooth') {
        let sum = 0, n = 0;
        if (ix > 0)      { sum += src[idx - 1];  n++; }
        if (ix < T.segX) { sum += src[idx + 1];  n++; }
        if (iz > 0)      { sum += src[idx - NX]; n++; }
        if (iz < T.segZ) { sum += src[idx + NX]; n++; }
        const avg = sum / n;
        heights[idx] += (avg - heights[idx]) * Math.min(1, brush.strength * f * dt * 12);
      }
    }
  }
  refreshTerrainRegion(ix0, iz0, ix1, iz1); // only chunks under the brush rebuild
  reseatPlantsIn(cx - rad, cz - rad, cx + rad, cz + rad); // plants re-seat to the new surface
  markFlowDirty(); // sculpting changes what's navigable
}

/* Per-frame brush servicing, driven from the main loop. */
function brushTick(dt) {
  if (brush.needRecast || brush.painting) {
    castBrush();
    brush.needRecast = false;
  }
  if (brush.mode === 'soil') updateSoilReadout();
  if (brush.painting) applyBrush(dt);
}

/* Show the carrying capacity of the patch under the cursor (calories), and what
 * the brush will stamp, so the effect of painting is visible numerically. */
function updateSoilReadout() {
  const el = document.getElementById('r-soil');
  if (!el) return;
  if (brush.hit) {
    const cur = Math.round(soilCap[soilPatchIndex(brush.hit.x, brush.hit.z)]);
    const tgt = brush.shift ? 0 : Math.round(soilBrush.value);
    el.textContent = `${cur} → ${tgt}`;
  } else {
    el.textContent = '—';
  }
}

/* ---- Pointer + keyboard wiring ---- */
renderer.domElement.addEventListener('pointerdown', e => {
  // A second touch means a two-finger gesture (zoom/rotate): cancel any
  // in-progress paint stroke so pinching doesn't drag a sculpt line.
  if (e.pointerType === 'touch' && !e.isPrimary) { brush.painting = false; return; }
  if (e.button !== 0 || brush.alt) return;
  if (brush.mode === 'place') {
    castBrush(); // ensure the hit is current even if the pointer hasn't moved
    if (brush.hit) spawnCreatureAt(brush.hit);
  } else {
    brush.painting = true;
  }
});
renderer.domElement.addEventListener('pointermove', e => {
  brush.ndc.set(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  brush.needRecast = true;
});
window.addEventListener('pointerup',   () => { brush.painting = false; });
renderer.domElement.addEventListener('pointerleave', () => {
  brush.painting = false;
  brushUniforms.uBrushOn.value = 0;
});

/* ------------------------------------------------------------
 * CREATURE CONTEXT MENU — right-click a creature to interact.
 * ------------------------------------------------------------ */
const creatureMenu = document.getElementById('creature-menu');
let menuAgent = null; // the agent under the context menu
const _screenPos = new THREE.Vector3();
const PICK_RADIUS = 40; // px — forgiving screen-space click radius

/* Screen-space proximity pick: project every live creature to screen coords
 * and return the closest one within PICK_RADIUS of the click. Much more
 * forgiving than mesh raycasting, especially on small/fast creatures. */
function pickCreature(clientX, clientY) {
  let best = null, bestDist = PICK_RADIUS;
  const all = [...fishes, ...frogs, ...birds];
  for (const a of all) {
    if (a.st.dead) continue;
    _screenPos.copy(a.mesh.position).project(camera);
    const sx = (_screenPos.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_screenPos.y * 0.5 + 0.5) * window.innerHeight;
    // Skip creatures behind the camera.
    if (_screenPos.z > 1) continue;
    const d = Math.hypot(clientX - sx, clientY - sy);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return best;
}

/* Project the menu agent's world position to screen and reposition the menu. */
function trackCreatureMenu() {
  if (!menuAgent) return;
  if (menuAgent.st.dead) { hideCreatureMenu(); return; }
  _screenPos.copy(menuAgent.mesh.position).project(camera);
  if (_screenPos.z > 1) { hideCreatureMenu(); return; } // behind camera
  const sx = (_screenPos.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-_screenPos.y * 0.5 + 0.5) * window.innerHeight;
  creatureMenu.style.left = sx + 'px';
  creatureMenu.style.top = sy + 'px';
}

function showCreatureMenu(x, y, agent) {
  menuAgent = agent;
  creatureMenu.style.left = x + 'px';
  creatureMenu.style.top = y + 'px';
  creatureMenu.classList.add('visible');
}

function hideCreatureMenu() {
  creatureMenu.classList.remove('visible');
  menuAgent = null;
}

// Suppress browser context menu on the canvas.
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

// Track right-click vs right-drag.
let _rmbDown = null;
let _rmbDrag = 0;

renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button === 2) {
    _rmbDown = { x: e.clientX, y: e.clientY };
    _rmbDrag = 0;
  }
  // Any left-click hides the menu.
  if (e.button === 0) hideCreatureMenu();
});

renderer.domElement.addEventListener('pointermove', e => {
  if (_rmbDown) {
    _rmbDrag += Math.abs(e.clientX - _rmbDown.x) + Math.abs(e.clientY - _rmbDown.y);
    _rmbDown = { x: e.clientX, y: e.clientY };
  }
});

window.addEventListener('pointerup', e => {
  if (e.button === 2 && _rmbDown) {
    if (_rmbDrag < 6 && !possessed) {
      const agent = pickCreature(e.clientX, e.clientY);
      if (agent && !agent.st.dead) showCreatureMenu(e.clientX, e.clientY, agent);
      else hideCreatureMenu();
    }
    _rmbDown = null;
  }
});

/* ------------------------------------------------------------
 * bindSlider — single pattern for every range input in the HUD.
 * Wires <input id> to its value label <id+'-v'>, parses the float,
 * formats the label, and calls apply(v). Runs once at startup so
 * runtime state always starts in sync with the markup defaults.
 * Programmatic changes should set input.value then
 * dispatchEvent(new Event('input')) to reuse the same path.
 * ------------------------------------------------------------ */
function bindSlider(id, apply, fmt = v => v.toFixed(1)) {
  const input = document.getElementById(id);
  const label = document.getElementById(id + '-v');
  const sync = () => {
    const v = parseFloat(input.value);
    label.textContent = fmt(v);
    apply(v);
  };
  input.addEventListener('input', sync);
  sync();
  return input;
}

/* Vegetation brush runtime settings (driven by the sliders below). */
const veg = { radius: 8, density: 0.5 };
const soilBrush = { value: SOIL.defaultCap }; // capacity the Soil brush stamps onto covered patches

/* The plant tool has its own radius (placement area) and density; all other
 * brushes share brush.radius. The ring shows whichever is active. */
function effectiveRingRadius() {
  return brush.mode === 'plant' ? veg.radius : brush.radius;
}
const syncBrushRing = () => { brushUniforms.uBrushRadius.value = effectiveRingRadius(); };

const radiusInput     = bindSlider('brush-radius',   v => { brush.radius   = v; syncBrushRing(); });
const strengthInput   = bindSlider('brush-strength', v => { brush.strength = v; }, v => v.toFixed(2));
const ampInput        = bindSlider('island-amp',     () => {}); // read at generate time
const vegDensityInput = bindSlider('veg-density',    v => { veg.density = v; }, v => v.toFixed(2));
const vegRadiusInput  = bindSlider('veg-radius',     v => { veg.radius  = v; syncBrushRing(); });
bindSlider('soil-cap', v => { soilBrush.value = v; }, v => String(Math.round(v))); // Soil-brush stamp value

// Live vegetation tuning feeds CONFIG.vegetation directly (the VEG alias
// declared in the vegetation section is the same object), so the change
// applies immediately. CONFIG is used here because VEG is declared later.
bindSlider('veg-growth',  v => { CONFIG.vegetation.foodRegrow = v; }, v => v.toFixed(4));
bindSlider('veg-maxsize', v => { CONFIG.vegetation.maxRadius  = v; }); // ceiling for plants spawned from now on
bindSlider('veg-seed',    v => { CONFIG.vegetation.seedRate   = v; }, v => v.toFixed(3)); // seed throws/sec per plant

document.getElementById('terrain-panel').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setBrushMode(btn.dataset.mode);
});
document.getElementById('gen-island').addEventListener('click', generateIsland);
document.getElementById('flatten').addEventListener('click', flattenTerrain);
document.getElementById('new-world').addEventListener('click', () => {
  // Re-open the setup menu pre-filled with the current world's params (drop go).
  const p = new URLSearchParams({
    w: String(Math.round(P.width)), l: String(Math.round(P.depth)), h: String(worldHeight),
    amp: String(worldAmp), water: String(water.level), veg: String(vegLevel),
  });
  try { location.hash = p.toString(); location.reload(); }
  catch (e) { document.getElementById('setup').classList.remove('hidden'); wireSetup(); }
});

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  // POV mode captures WASD and Escape.
  if (possessed) {
    if (k in povKeys) { povKeys[k] = true; e.preventDefault(); }
    return;
  }
  if (k === 'w') setBrushMode('raise');
  if (k === 'e') setBrushMode('lower');
  if (k === 'r') setBrushMode('smooth');
  if (k === 'z') setBrushMode('zone');
  if (k === 'c') setBrushMode('soil');
  if (k === 't') setBrushMode('place');
  if (k === 'p') setBrushMode('plant');
  if (k === '[' || k === ']') {
    const input = brush.mode === 'plant' ? vegRadiusInput : radiusInput;
    const rMin = parseFloat(input.min), rMax = parseFloat(input.max);
    const rStep = (rMax - rMin) / 30;
    const cur = parseFloat(input.value);
    input.value = Math.min(rMax, Math.max(rMin, cur + (k === ']' ? rStep : -rStep)));
    input.dispatchEvent(new Event('input')); // reuse the bindSlider path (state + label + ring)
    brush.needRecast = true;
  }
  if (e.key === 'Shift') brush.shift = true;
  if (e.key === 'Alt')   { brush.alt = true; syncControlButtons(); castBrush(); e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k in povKeys) povKeys[k] = false;
  if (e.key === 'Shift') brush.shift = false;
  if (e.key === 'Alt')   { brush.alt = false; syncControlButtons(); brush.needRecast = true; }
});

/* ============================================================
 * WATER  —  fixed level filling the platform from the datum up
 *
 * Rendered as a translucent volume (not just a plane) so the
 * water line reads correctly at the platform rim from the side.
 * `water.level` is the value ecology code will compare heights
 * against later (submerged / shoreline / dry).
 * ============================================================ */
const water = { level: 0.8 };

const waterGeo = new THREE.BoxGeometry(P.width, 1, P.depth); // unit height, scaled live
const waterMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(css.getPropertyValue('--water').trim()),
  transparent: true,
  opacity: 0.45,
  roughness: 0.15,
  metalness: 0.0,
  depthWrite: false, // avoid sorting artifacts against the terrain beneath
});
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.renderOrder = 1; // draw after opaque terrain
platformGroup.add(waterMesh);

function setWaterLevel(level) {
  water.level = level;
  if (level <= 0.001) {
    waterMesh.visible = false;
  } else {
    waterMesh.visible = true;
    waterMesh.scale.y = level;
    waterMesh.position.y = level / 2; // volume spans y = 0 .. level
  }
  markFlowDirty(); // navigable area changed
}

const waterInput = bindSlider('water-level', setWaterLevel, v => v.toFixed(2));
let waterOpacity = 0.45; // 0..1; driven by the opacity slider (0..100)
bindSlider('water-opacity', v => {
  waterOpacity = v / 100;
  waterMat.opacity = 0.05 + waterOpacity * 0.9; // 0.05 (crystal clear) to 0.95 (near opaque)
}, v => Math.round(v).toString());

/* ============================================================
 * FISH  —  aquatic population: rectangular hitboxes with two
 * modes of land contact.
 *
 *  swim:    navigable iff water depth covers the hitbox plus a
 *           margin; steps onto land are rejected.
 *  beached: full land contact — gravity drops it onto the
 *           heightfield, seated to the local slope, and it
 *           flops toward the deepest nearby water until it can
 *           swim again.
 * ============================================================ */
/* ── Species data ──────────────────────────────────────────────────────────
 * Load every config/species/*.json BEFORE the engine's synchronous init, so the
 * built-in fish/frog/insect/plant can be defined from data just like the custom
 * species (top-level await — main.js is an ES module). SPECIES_DEFS is keyed by
 * id; RAW_SPECIES preserves manifest order for registration + the config editor.
 * world.js now holds only world structure and shared, cross-species defaults
 * (hunger, grazing, predation, death, predator, breeding._default, vegetation). */
const RAW_SPECIES = []; // [{ file, def }]
async function loadSpeciesData() {
  const byId = {};
  let files = [];
  try {
    const mani = await (await fetch('config/species/manifest.json')).json();
    files = Array.isArray(mani.files) ? mani.files : [];
  } catch (e) { console.error('species manifest load failed —', e.message); }
  // Fetch all files in parallel (was sequential — with 130+ species that meant
  // 130 serial round-trips and a multi-second blank load). Results are collected
  // back in manifest order so registration + the config editor stay stable.
  const loaded = await Promise.all(files.map(async f => {
    try { return { file: f, def: await (await fetch('config/species/' + f)).json() }; }
    catch (e) { console.error('species file "' + f + '" failed to load —', e.message); return null; }
  }));
  for (const r of loaded) {
    if (!r) continue;
    RAW_SPECIES.push(r);
    if (r.def && r.def.id) byId[r.def.id] = r.def;
  }
  return byId;
}
const SPECIES_DEFS = await loadSpeciesData();

/* A core built-in species file is missing/corrupt — surface it instead of a
 * blank screen (the engine can't size hitboxes/breeding without these). */
function requireDef(id) {
  const d = SPECIES_DEFS[id];
  if (!d || !d.cfg) {
    const msg = 'Config error: missing or invalid config/species/' + id + '.json';
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
      + 'justify-content:center;background:#0e1116;color:#ff6b6b;font:14px ui-monospace,monospace;'
      + 'text-align:center;padding:24px">' + msg + '</div>');
    throw new Error(msg);
  }
  return d;
}

const FISH = requireDef('fish').cfg;
const fishGeo = new THREE.BoxGeometry(FISH.length, FISH.height, FISH.width);
const fishMat = new THREE.MeshStandardMaterial({
  color: 0xff3b30,            // bright primary red — reads through the water
  emissive: 0x661111,
  emissiveIntensity: 0.5,
  roughness: 0.5,
});

const fishes = [];  // { mesh, st }
const frogs  = [];  // { mesh, st } — declared here so the shared cap sees both
const birds  = [];  // { mesh, st }
const eggs   = [];  // { mesh, st } — fish eggs
const AGENT_CAP = Infinity; // no creature limit (was a perf guard); watch FPS at scale
const agentCount = () => fishes.length + frogs.length + birds.length;

let nextCreatureId = 1; // unique id across ALL creatures (egg fertilization needs identity)

/* Resolve each species' breeding config by merging its overrides onto the
 * shared default. Add a species here (or rely on the default) to extend. */
const BREEDING = {};
for (const key of ['fish', 'frog', 'insect']) {
  BREEDING[key] = Object.assign({}, CONFIG.breeding._default, requireDef(key).breeding);
}
const BREED_F = BREEDING.fish; // fish keeps its own handle (zone-seeking logic)

const randomLayInterval = (br) =>
  br.mtbLayEgg * (1 + (Math.random() * 2 - 1) * br.layEggSpread);

/* Species registry — the single point of extensibility. Each entry maps a
 * species key to the array it lives in, a uniform spawn(x, z, opts) call,
 * and its breeding config. Fliers (bird/insect/bigbird) share the `birds`
 * array but are distinguished by st.species. To add a species: define its
 * spawn function and add one entry here. */
const SPECIES = {
  fish:    { list: fishes, spawn: (x, z, o) => spawnFish(x, z, o),            br: BREEDING.fish },
  frog:    { list: frogs,  spawn: (x, z, o) => spawnFrog(x, z, o),            br: BREEDING.frog },
  insect:  { list: birds,  spawn: (x, z, o) => spawnBird('insect', x, z, o),  br: BREEDING.insect },
};

/* Shared maturation, food-gated. A newborn carries st.growth (food eaten so
 * far) toward br.growthFood (its body mass). feedGrowth() below adds to it
 * whenever the baby eats; this per-frame step only keeps the visual scale in
 * sync and flips to adult once the body mass has been consumed. No time term:
 * a baby that never finds food never grows up. */
function maturationStep(a, br, dt) {
  const st = a.st;
  if (st.mature) return;
  const k = Math.min(1, st.growth / br.growthFood);
  a.mesh.scale.setScalar(br.juvenileScale + (1 - br.juvenileScale) * k);
  if (st.growth >= br.growthFood) {
    st.mature = true;
    a.mesh.scale.setScalar(1);
    st.layTimer = randomLayInterval(br);
  }
}

/* Credit food a baby just ate toward growing up. Called from the graze path.
 * Maturing mid-tick is fine — maturationStep finalizes the scale next frame. */
function feedGrowth(st, amount) {
  if (!st.mature) st.growth = (st.growth || 0) + amount;
}

/* Shared laying for species that lay in place (everyone except zone-seeking
 * fish): a mature individual whose clock has expired drops an egg where it
 * stands, provided it's somewhere a newborn could survive (canLayHere). */
/* Reproduction energy gate. A creature must be a grown adult, above the
 * survival floor (reproMinFrac of max), AND hold enough reserve to pay the
 * act's cost without dropping below that floor. Food-gated growth means
 * st.mature is only ever true once the baby has eaten its body mass, so
 * babies are excluded here automatically.
 *
 * Hunger initializes lazily on the first hunger tick; a creature that hasn't
 * ticked yet (st.hunger undefined) counts as fed. */
function canReproduce(st, cost = 0) {
  if (!st.mature) return false;
  if (st.hunger === undefined || !st.maxHunger) return true;
  const floor = CONFIG.hunger.reproMinFrac * st.maxHunger;
  return st.hunger >= floor + cost * st.maxHunger;
}

/* Spend a reproduction cost (fraction of max) from a creature's reserve. */
function payReproCost(st, costFrac) {
  if (st.hunger === undefined || !st.maxHunger) return;
  st.hunger = Math.max(0, st.hunger - costFrac * st.maxHunger);
}

function layStep(a, br, dt, canLayHere) {
  const st = a.st;
  if (!st.mature) return;
  st.layTimer -= dt;
  // Hold a ready timer when too hungry to afford laying; resumes once fed
  // back above the cost+floor (and in a valid spot).
  if (st.layTimer <= 0 && canLayHere && canReproduce(st, br.layCost)) {
    layEgg(a);
    payReproCost(st, br.layCost);
    st.layTimer = randomLayInterval(br);
  }
}

/* ============================================================
 * CREATURE MODELS — two interchangeable visual styles per species.
 *
 *   'primitive' : the original single-box (programmer art).
 *   'detailed'  : a composed Group of primitives forming a
 *                 recognizable silhouette (body, fins/wings/legs,
 *                 eyes), built to the SAME hitbox dimensions and
 *                 the SAME forward axis (local +X) so physics and
 *                 orientAgent() are identical between styles.
 *
 * buildModel(species) returns a fresh Object3D each call (meshes
 * can't be shared across multiple scene-graph parents). artMode
 * selects which; the Display toggle swaps every live creature in
 * place via rebuildCreatureVisuals().
 * ============================================================ */
let artMode = 'detailed'; // 'primitive' | 'detailed'

// Per-species materials, built lazily once and shared across all models of
// that part. Mirrors the primitive palette so the two styles read as the
// same animals.
const _matCache = {};
function cmat(key, opts) { return _matCache[key] || (_matCache[key] = new THREE.MeshStandardMaterial(opts)); }

function eyePair(fwd, up, side, r = 0.12) {
  const g = new THREE.Group();
  const eyeMat = cmat('eye', { color: 0x111111, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), eyeMat);
    e.position.set(fwd, up, s * side);
    g.add(e);
  }
  return g;
}

/* Detailed builders. Each is sized from the species' hitbox (L×H×W along
 * X×Y×Z) so the visible model fills the same volume the collision math uses,
 * with the nose/head toward local +X to match orientAgent's forward axis. */
/* ---- Fish color genetics ----
 * Each fish carries a color gene (st.color). Placed/initial fish roll a random
 * vivid color; fish born from an egg inherit the average of their two parents'
 * colors with a small HSL mutation. Colors are generated in HSL so they read
 * as lively fish rather than muddy random RGB. */
function randomFishColor() {
  return new THREE.Color().setHSL(Math.random(), 0.55 + Math.random() * 0.35, 0.42 + Math.random() * 0.16);
}
function mixFishColor(a, b) {
  const c = new THREE.Color((a.r + b.r) / 2, (a.g + b.g) / 2, (a.b + b.b) / 2); // parent average
  const hsl = {}; c.getHSL(hsl);                                                // then mutate a touch
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  c.setHSL(
    (hsl.h + (Math.random() - 0.5) * 0.08 + 1) % 1,
    cl(hsl.s + (Math.random() - 0.5) * 0.14, 0.2, 1),
    cl(hsl.l + (Math.random() - 0.5) * 0.10, 0.25, 0.78)
  );
  return c;
}

// Approved low-poly fish (see model-review). Built through the shared
// declarative parts pipeline so gene-tinted fish — and koi, which reuses this
// builder — recolor automatically via the "body"/"bodyDark" roles.
const FISH_PARTS = [
  { shape: 'sphere', scale: [1.7, 0.62, 0.92], color: 'body' },                                   // torpedo body
  { shape: 'sphere', pos: [0.6, 0, 0], scale: [0.9, 0.6, 0.82], color: 'body' },                  // fuller head
  { shape: 'sphere', pos: [1.0, -0.03, 0], scale: [0.42, 0.4, 0.5], color: 'body' },              // rounded snout
  { shape: 'cone', pos: [-1.02, 0, 0], rot: [0, 0, 1.5708], scale: [0.85, 0.72, 0.16], color: 'bodyDark' }, // caudal fin
  { shape: 'cone', pos: [0.05, 0.52, 0], scale: [0.55, 0.55, 0.13], color: 'bodyDark' },          // dorsal fin
  { shape: 'cone', pos: [-0.28, -0.38, 0], rot: [3.14159, 0, 0], scale: [0.34, 0.32, 0.1], color: 'bodyDark' }, // anal fin
  { shape: 'cone', pos: [0.34, -0.16, 0.4], rot: [0.7, 0, 2.2], scale: [0.22, 0.5, 0.1], color: 'bodyDark' },   // pectoral L
  { shape: 'cone', pos: [0.34, -0.16, -0.4], rot: [-0.7, 0, 2.2], scale: [0.22, 0.5, 0.1], color: 'bodyDark' }, // pectoral R
  { shape: 'eyes', pos: [0.78, 0.16, 0.3], r: 0.11 },
];
function buildFishDetailed(tint) {
  return buildPartsModel(FISH_PARTS, 0xff3b30, tint);
}

/* Generic declarative model builder for JSON-defined species. Reads a parts
 * list of primitives — each { shape, pos, rot, scale, color } — so a new
 * species' 3D model is fully data-driven. `color` may be a hex, or the roles
 * "body"/"bodyDark"/"accent" which resolve against the species' base/gene color
 * (so a tinted/genetic species recolors automatically). */
function buildPartsModel(parts, baseColor, tint, pov) {
  const g = new THREE.Group();
  const bodyCol = tint || new THREE.Color(baseColor != null ? baseColor : 0xffffff);
  for (const part of (parts || [])) {
    if (part.shape === 'eyes') {            // symmetric eye pair (like the built-ins)
      const p = part.pos || [0.3, 0.2, 0.2];
      g.add(eyePair(p[0], p[1], p[2], part.r || 0.1));
      continue;
    }
    let geo;
    switch (part.shape) {
      case 'sphere':   geo = new THREE.SphereGeometry(0.5, 12, 9); break;
      case 'cone':     geo = new THREE.ConeGeometry(0.5, 1, 10); break;
      case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10); break;
      default:         geo = new THREE.BoxGeometry(1, 1, 1);
    }
    const spec = part.color;
    const col = (spec == null || spec === 'body') ? bodyCol.clone()
              : spec === 'bodyDark' ? bodyCol.clone().multiplyScalar(0.7)
              : spec === 'accent'   ? bodyCol.clone().offsetHSL(0.5, 0, 0)
              : new THREE.Color(spec);
    const mat = new THREE.MeshStandardMaterial({
      color: col, roughness: part.roughness != null ? part.roughness : 0.6, metalness: 0,
      emissive: part.glow ? col.clone().multiplyScalar(0.3) : new THREE.Color(0x000000),
      emissiveIntensity: part.glow ? 0.5 : 0,
    });
    const m = new THREE.Mesh(geo, mat);
    const s = part.scale == null ? [1, 1, 1] : (Array.isArray(part.scale) ? part.scale : [part.scale, part.scale, part.scale]);
    m.scale.set(s[0], s[1], s[2]);
    if (part.pos) m.position.set(part.pos[0], part.pos[1], part.pos[2]);
    if (part.rot) m.rotation.set(part.rot[0], part.rot[1], part.rot[2]);
    m.castShadow = true;
    g.add(m);
  }
  addEyeAnchor(g, parts, pov);
  return g;
}

/* First-person camera anchor: an empty Object3D at the creature's eye point in
 * MODEL-LOCAL space (forward = +X, height = +Y, laterally centred). Parented to
 * the model group, so its world position tracks every transform — sizeScale,
 * the terrestrial foot-pin, heading, and fish pitch — and POV can snap the
 * camera straight to it. Source of the point, in priority order:
 *   1. the species' explicit `pov: { forward, height }` (config/species/*.json)
 *   2. the model's `eyes` part position (most models carry one)
 *   3. a fallback near the front-top of the bounding box (e.g. the butterfly). */
function addEyeAnchor(g, parts, pov) {
  let fwd, up;
  const lat = (pov && pov.lateral != null) ? pov.lateral : 0; // side offset (local Z)
  if (pov && (pov.forward != null || pov.height != null)) {
    fwd = pov.forward != null ? pov.forward : 0;
    up  = pov.height  != null ? pov.height  : 0;
  } else {
    const eye = (parts || []).find(p => p.shape === 'eyes' && p.pos);
    if (eye) { fwd = eye.pos[0]; up = eye.pos[1]; }
    else {
      const box = new THREE.Box3().setFromObject(g);
      fwd = box.max.x * 0.9;                 // just shy of the nose
      up  = box.min.y + (box.max.y - box.min.y) * 0.75; // upper body
    }
  }
  const a = new THREE.Object3D();
  a.name = 'eyeAnchor';
  a.position.set(fwd, up, lat);
  g.add(a);
}

/* Wrap a detailed-model builder so its output is scaled by `s` (real-world size
 * ratio). When `seat` is true (ground animals), the model's bottom is pinned in
 * place so it grows upward from its feet — scaling never shifts where it sits.
 * Otherwise it scales about the origin (swimmers/fliers, positioned by centre). */
function scaleBuilder(buildFn, s, seat) {
  return (tint) => {
    const g = buildFn(tint);
    if (seat) {
      const minY = new THREE.Box3().setFromObject(g).min.y; // unscaled foot line
      g.scale.setScalar(s);
      g.position.y = minY * (1 - s);                        // keep that foot line fixed
    } else {
      g.scale.setScalar(s);
    }
    const wrap = new THREE.Group();
    wrap.add(g);
    return wrap;
  };
}

function buildFrogDetailed() {
  const L = FROG.length, H = FROG.height, W = FROG.width;
  const g = new THREE.Group();
  const skin = cmat('frogSkin', { color: 0x2ecc40, emissive: 0x0a4412, emissiveIntensity: 0.4, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 9), skin);
  body.scale.set(L, H * 1.1, W);          // wide squat dome
  body.position.y = H * 0.1;
  g.add(body);
  const pupilMat = cmat('eye', { color: 0x111111, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(H * 0.32, 8, 6), skin);
    e.position.set(L * 0.34, H * 0.6, s * W * 0.28);
    g.add(e);
    const p = new THREE.Mesh(new THREE.SphereGeometry(H * 0.16, 6, 5), pupilMat);
    p.position.set(L * 0.34 + 0.12, H * 0.66, s * W * 0.28);
    g.add(p);
  }
  for (const s of [-1, 1]) {               // hind legs splayed back along -X
    const leg = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 5), skin);
    leg.scale.set(L * 0.5, H * 0.4, W * 0.22);
    leg.position.set(-L * 0.3, -H * 0.15, s * W * 0.34);
    g.add(leg);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  addEyeAnchor(g, null, { forward: FROG.length * 0.34, height: FROG.height * 0.6 }); // POV at the frog's eyes
  return g;
}

/* Fliers share a builder: body + head + two swept wings (+ beak/tail for
 * birds). Insect gets a darker round body and translucent stub wings. */
function buildFlierDetailed(type) {
  const sp = FLIERS[type].cfg;
  const L = sp.length, H = sp.height, W = sp.width;
  const isInsect = type === 'insect';
  const col = isInsect ? 0x111111 : 0xffffff;
  const g = new THREE.Group();
  const bodyMat = cmat('flier_' + type, {
    color: col,
    emissive: isInsect ? 0x000000 : 0x333333,
    emissiveIntensity: isInsect ? 0 : 0.25,
    roughness: isInsect ? 0.7 : 0.55,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 9), bodyMat);
  body.scale.set(L * (isInsect ? 0.9 : 0.7), H * 0.7, W * 0.5);
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(H * 0.3, 8, 6), bodyMat);
  head.position.set(L * 0.42, H * 0.12, 0);
  g.add(head);
  if (!isInsect) {
    const beak = new THREE.Mesh(new THREE.ConeGeometry(H * 0.12, L * 0.22, 4),
      cmat('beak', { color: 0xffae42, roughness: 0.5 }));
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(L * 0.6, H * 0.1, 0);
    g.add(beak);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(W * 0.5, L * 0.4, 3), bodyMat);
    tail.rotation.z = Math.PI / 2;
    tail.scale.set(1, 1, 0.2);
    tail.position.set(-L * 0.5, 0, 0);
    g.add(tail);
  }
  const wingMat = isInsect
    ? cmat('insectWing', { color: 0x6fd0ff, transparent: true, opacity: 0.5, roughness: 0.3 })
    : bodyMat;
  for (const s of [-1, 1]) {               // wings span ±W, swept slightly back
    const wing = new THREE.Mesh(new THREE.BoxGeometry(L * 0.5, H * 0.06, W * 0.7), wingMat);
    wing.position.set(-L * 0.05, H * 0.2, s * W * 0.55);
    wing.rotation.y = s * 0.3;
    g.add(wing);
  }
  g.add(eyePair(L * 0.5, H * 0.2, H * 0.12, H * 0.12));
  addEyeAnchor(g, null, { forward: L * 0.5, height: H * 0.2 }); // POV at the flier's eyes
  g.traverse(o => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
  return g;
}

const DETAILED_BUILDERS = {
  fish: scaleBuilder(buildFishDetailed, 1.4, false), // tetra ~4cm; koi reuses this
  frog: buildFrogDetailed,                           // 2cm reference (sizeScale 1.0)
  insect: () => buildFlierDetailed('insect'),
};

/* ---- Imported fish GLB (Quaternius "Fish", CC0 — assets/models/) ----
 * The detailed fish becomes a real 3D model, loaded asynchronously. Until it's
 * ready the procedural fish stands in; once loaded, every live fish swaps to it.
 * It's fitted to the procedural fish's bounds and to local +X forward (the axis
 * orientAgent uses), exactly as validated in model-review/editor.html. */
let FISH_GLB = null;
let FISH_GLB_CLIPS = null; // baked animation clips (e.g. "Armature|Swim")
const _glbV = new THREE.Vector3();
// Measure-only procedural fish, to match the GLB's size to the existing look.
const _fishRefBox = new THREE.Box3().setFromObject(scaleBuilder(buildFishDetailed, 1.4, false)());
const _fishRefSize = _fishRefBox.getSize(new THREE.Vector3());
const _fishRefCenter = _fishRefBox.getCenter(new THREE.Vector3());

new GLTFLoader().load('assets/models/fish_quaternius.glb', (gltf) => {
  const inner = gltf.scene;
  inner.rotation.y = Math.PI / 2;                       // nose -> +X (engine forward)
  inner.updateMatrixWorld(true);
  let b = new THREE.Box3().setFromObject(inner);
  const gs = b.getSize(_glbV);
  inner.scale.setScalar(Math.max(_fishRefSize.x, _fishRefSize.y, _fishRefSize.z) / (Math.max(gs.x, gs.y, gs.z) || 1));
  inner.updateMatrixWorld(true);
  b = new THREE.Box3().setFromObject(inner);
  inner.position.sub(b.getCenter(_glbV)).add(_fishRefCenter); // centre like the procedural fish
  inner.traverse(o => { if (o.isMesh) o.castShadow = true; });
  FISH_GLB = new THREE.Group(); FISH_GLB.add(inner);
  FISH_GLB_CLIPS = gltf.animations || null; // tail-undulation swim cycle
  rebuildCreatureVisuals(); // swap any already-spawned fish to the GLB
}, undefined, (e) => console.warn('fish GLB load failed; using procedural fish', e));

// Clone the GLB template, tint its materials to the fish's gene colour, and add
// a POV eye anchor derived from the model bounds. The model is SKINNED, so it
// must be cloned with SkeletonUtils (a plain .clone() leaves clones bound to the
// original skeleton and they collapse / vanish).
function buildFishGLB(tint) {
  const m = cloneSkinned(FISH_GLB);
  if (tint) m.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = mats.map(src => {
      const c = src.clone();
      c.color = (c.color ? c.color.clone() : new THREE.Color(0xffffff)).multiply(tint);
      return c;
    });
    o.material = cloned.length === 1 ? cloned[0] : cloned;
  });
  // Per-fish swim animation (tail undulation). Randomize phase + tempo so a
  // school doesn't beat in unison. The mixer is updated from the main loop.
  if (FISH_GLB_CLIPS && FISH_GLB_CLIPS.length) {
    const mixer = new THREE.AnimationMixer(m);
    const clip = FISH_GLB_CLIPS[0];
    const action = mixer.clipAction(clip);
    action.time = Math.random() * clip.duration;
    action.timeScale = 0.8 + Math.random() * 0.5;
    action.play();
    m.userData.mixer = mixer;
  }
  addEyeAnchor(m, [], null); // bbox-derived eye point (front-top) for first-person POV
  return m;
}
// The fish's detailed model is the GLB once loaded, else the procedural fallback.
DETAILED_BUILDERS.fish = (tint) => FISH_GLB ? buildFishGLB(tint) : scaleBuilder(buildFishDetailed, 1.4, false)(tint);

/* ---- Imported frog GLB (Quaternius "Frog", CC0 — assets/models/) ----
 * Same pipeline as the fish: async load with procedural fallback, SkeletonUtils
 * clone, fitted to the procedural frog's bounds and +X forward, with the baked
 * idle animation. Frogs aren't gene-coloured, so the native material is kept.
 * (FROG cfg is declared later in the file, so the reference box — which needs
 * buildFrogDetailed — is measured inside the async callback, at runtime.) */
let FROG_GLB = null;
let FROG_GLB_CLIPS = null;

new GLTFLoader().load('assets/models/frog_quaternius.glb', (gltf) => {
  const refBox = new THREE.Box3().setFromObject(buildFrogDetailed());
  const refSize = refBox.getSize(new THREE.Vector3());
  const refCenter = refBox.getCenter(new THREE.Vector3());
  const inner = gltf.scene;
  inner.rotation.y = Math.PI / 2;                      // nose -> +X
  inner.updateMatrixWorld(true);
  let b = new THREE.Box3().setFromObject(inner);
  const gs = b.getSize(_glbV);
  inner.scale.setScalar(Math.max(refSize.x, refSize.y, refSize.z) / (Math.max(gs.x, gs.y, gs.z) || 1));
  inner.updateMatrixWorld(true);
  b = new THREE.Box3().setFromObject(inner);
  inner.position.sub(b.getCenter(_glbV)).add(refCenter);  // centre like the procedural frog (seated by centre)
  inner.traverse(o => { if (o.isMesh) o.castShadow = true; });
  FROG_GLB = new THREE.Group(); FROG_GLB.add(inner);
  FROG_GLB_CLIPS = gltf.animations || null;             // Idle / Jump / Attack / Death
  rebuildCreatureVisuals();
}, undefined, (e) => console.warn('frog GLB load failed; using procedural frog', e));

function buildFrogGLB() {
  const m = cloneSkinned(FROG_GLB);
  if (FROG_GLB_CLIPS && FROG_GLB_CLIPS.length) {
    const clip = FROG_GLB_CLIPS.find(c => /idle/i.test(c.name)) || FROG_GLB_CLIPS[0];
    const mixer = new THREE.AnimationMixer(m);
    const action = mixer.clipAction(clip);
    action.time = Math.random() * clip.duration; // desync the school
    action.timeScale = 0.85 + Math.random() * 0.4;
    action.play();
    m.userData.mixer = mixer;
  }
  addEyeAnchor(m, null, { forward: FROG.length * 0.34, height: FROG.height * 0.6 }); // POV at the eyes
  return m;
}
DETAILED_BUILDERS.frog = () => FROG_GLB ? buildFrogGLB() : buildFrogDetailed();

/* ---- Hand-authored low-poly beetle GLB (assets/models/beetle_lowpoly.glb,
 * built by tools/make_beetle_glb.py) — upscales the primitive parts beetle, and
 * carries a baked "Scurry" node animation (two alternating leg tripods + body
 * bob). Authored in +X/centred convention. The beetle is a JSON species, so its
 * detailed builder is overridden inside the async callback, after registerSpecies
 * has populated DETAILED_BUILDERS. */
new GLTFLoader().load('assets/models/beetle_lowpoly.glb', (gltf) => {
  if (!DETAILED_BUILDERS.beetle) return;
  // Fit the rigged scene to the procedural beetle's bounds (centre-aligned).
  const refBox = new THREE.Box3().setFromObject(DETAILED_BUILDERS.beetle());
  const refSize = refBox.getSize(new THREE.Vector3());
  const refCenter = refBox.getCenter(new THREE.Vector3());
  const inner = gltf.scene;
  inner.updateMatrixWorld(true);
  let b = new THREE.Box3().setFromObject(inner);
  const gs = b.getSize(_glbV);
  inner.scale.setScalar(Math.max(refSize.x, refSize.y, refSize.z) / (Math.max(gs.x, gs.y, gs.z) || 1));
  inner.updateMatrixWorld(true);
  b = new THREE.Box3().setFromObject(inner);
  inner.position.sub(b.getCenter(_glbV)).add(refCenter);
  inner.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const template = new THREE.Group(); template.add(inner);
  const clips = gltf.animations || null;
  DETAILED_BUILDERS.beetle = () => {
    const m = cloneSkinned(template);
    if (clips && clips.length) {
      const clip = clips.find(c => /scurry/i.test(c.name)) || clips[0];
      const mixer = new THREE.AnimationMixer(m);
      const action = mixer.clipAction(clip);
      action.time = Math.random() * clip.duration; // desync the swarm
      action.timeScale = 0.9 + Math.random() * 0.5;
      action.play();
      m.userData.mixer = mixer;
    }
    addEyeAnchor(m, null, { forward: 0.6, height: 0.18 }); // POV near the head
    return m;
  };
  rebuildCreatureVisuals();
}, undefined, (e) => console.warn('beetle GLB load failed; using procedural beetle', e));

/* ---- Batch creature upscales: pulled low-poly GLBs for JSON species --------
 * Generic version of the fish/frog/beetle path: load async, fit to the species'
 * procedural bounds (centre-aligned), clone with SkeletonUtils, play the model's
 * animation, and override the species' detailed builder once registerSpecies has
 * populated it. rotY is the per-model forward-axis fix (engine faces +X). */
const CREATURE_GLB = [ // hand-authored low-poly GLBs (tools/make_*_glb.py, make_fauna.py), built facing +X
  { id: 'jaguar',              file: 'jaguar_lowpoly.glb',   rotY: 0 },
  { id: 'capybara',            file: 'capybara_lowpoly.glb', rotY: 0 },
  { id: 'macaw',               file: 'macaw_lowpoly.glb',    rotY: 0 },
  { id: 'boa',                 file: 'boa_lowpoly.glb',      rotY: 0 },
  { id: 'red_footed_tortoise', file: 'tortoise_lowpoly.glb', rotY: 0 },
  { id: 'ocelot',              file: 'ocelot_lowpoly.glb',       rotY: 0 },
  { id: 'agouti',              file: 'agouti_lowpoly.glb',       rotY: 0 },
  { id: 'peccary',             file: 'peccary_lowpoly.glb',      rotY: 0 },
  { id: 'sloth',               file: 'sloth_lowpoly.glb',        rotY: 0 },
  { id: 'black_caiman',        file: 'black_caiman_lowpoly.glb', rotY: 0 },
  { id: 'anole',               file: 'anole_lowpoly.glb',        rotY: 0 },
  { id: 'dart_frog',           file: 'dart_frog_lowpoly.glb',    rotY: 0 },
  { id: 'harpy_eagle',         file: 'harpy_eagle_lowpoly.glb',  rotY: 0 },
  { id: 'insect_bat',          file: 'insect_bat_lowpoly.glb',   rotY: 0 },
  { id: 'butterfly',           file: 'butterfly_lowpoly.glb',    rotY: 0 },
  { id: 'piranha',             file: 'piranha_lowpoly.glb',      rotY: 0 },
  { id: 'ant',                 file: 'ant_lowpoly.glb',          rotY: 0 },
  { id: 'monkey',              file: 'monkey_lowpoly.glb',       rotY: 0 },
];
const _clipPref = /idle|walk|run|fly|move|swim|crawl|slither/i;
for (const cg of CREATURE_GLB) {
  new GLTFLoader().load('assets/models/' + cg.file, (gltf) => {
    const proc = DETAILED_BUILDERS[cg.id];
    if (!proc) return;                                   // species not registered (skipped)
    const refBox = new THREE.Box3().setFromObject(proc());
    const refSize = refBox.getSize(new THREE.Vector3());
    const refCenter = refBox.getCenter(new THREE.Vector3());
    const inner = gltf.scene;
    inner.rotation.y = cg.rotY;
    inner.updateMatrixWorld(true);
    let b = new THREE.Box3().setFromObject(inner);
    const gs = b.getSize(_glbV);
    inner.scale.setScalar(Math.max(refSize.x, refSize.y, refSize.z) / (Math.max(gs.x, gs.y, gs.z) || 1));
    inner.updateMatrixWorld(true);
    b = new THREE.Box3().setFromObject(inner);
    inner.position.sub(b.getCenter(_glbV)).add(refCenter);  // centre-align like the procedural model
    inner.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const template = new THREE.Group(); template.add(inner);
    const clips = gltf.animations || [];
    const clip = clips.find(c => _clipPref.test(c.name)) || clips[0] || null;
    DETAILED_BUILDERS[cg.id] = () => {
      const m = cloneSkinned(template);
      if (clip) {
        const mx = new THREE.AnimationMixer(m);
        const a = mx.clipAction(clip);
        a.time = Math.random() * clip.duration; a.timeScale = 0.9 + Math.random() * 0.3;
        a.play();
        m.userData.mixer = mx;
      }
      addEyeAnchor(m, null, { forward: refSize.x * 0.32, height: refSize.y * 0.55 });
      return m;
    };
    rebuildCreatureVisuals();
  }, undefined, (e) => console.warn(cg.id + ' GLB load failed; keeping procedural', e));
}

/* Build a creature's visual root for the current artMode. Primitive returns
 * a single Mesh (original geo/mat); detailed returns a composed Group. */
function buildModel(species, geo, primitiveMat, tint) {
  if (artMode === 'primitive') {
    const mat = tint
      ? Object.assign(primitiveMat.clone(), { color: tint.clone() }) // per-instance gene color
      : primitiveMat;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }
  return DETAILED_BUILDERS[species](tint); // only the fish builder uses tint; others ignore it
}

/* Swap every live creature to the current artMode, preserving each one's
 * transform, scale, and scene attachment. */
function rebuildCreatureVisuals() {
  const swap = (a, species, geo, primitiveMat) => {
    if (a.st.dead) return; // let corpses finish fading in their current style
    const old = a.mesh;
    const next = buildModel(species, geo, primitiveMat, a.st.color); // st.color only set on fish
    next.position.copy(old.position);
    next.quaternion.copy(old.quaternion);
    next.scale.copy(old.scale);
    platformGroup.remove(old);
    platformGroup.add(next);
    a.mesh = next;
    next.userData.agent = a;
  };
  for (const a of fishes) swap(a, a.st.species, RENDER_KIT[a.st.species].geo, RENDER_KIT[a.st.species].mat);
  for (const a of frogs)  swap(a, a.st.species, RENDER_KIT[a.st.species].geo, RENDER_KIT[a.st.species].mat);
  for (const a of birds)  swap(a, a.st.species, FLIERS[a.st.species].geo, FLIERS[a.st.species].mat);
}

/* Shared agent scaffold: mesh creation, identity, breeding clocks, and the
 * juvenile scale. Species pass their own locomotion fields via extraState;
 * everything here is identical across fish / frog / fliers. */
function createAgent(species, br, geo, primitiveMat, extraState, newborn, tint) {
  const mesh = buildModel(species, geo, primitiveMat, tint);
  platformGroup.add(mesh);
  const st = Object.assign({
    id: nextCreatureId++,  // identity, so an egg can require a *different* individual
    species,
    heading: Math.random() * Math.PI * 2,
    growth: newborn ? 0 : br.growthFood, // food eaten toward adulthood; adults start full
    mature: !newborn,
    layTimer: randomLayInterval(br),
  }, extraState);
  if (newborn) mesh.scale.setScalar(br.juvenileScale); // grows to 1.0 over maturation
  const agent = { mesh, st };
  mesh.userData.agent = agent;
  return agent;
}

/* Land-species drop-in: spawn above the surface (or above the water line if
 * the spot is submerged) and let the species tick resolve the landing. */
function dropFromAbove(mesh, x, z, halfHeight) {
  mesh.position.set(
    x,
    Math.max(sampleHeight(x, z) + halfHeight + 1.5, water.level + 0.5),
    z
  );
}

const fishMinDepth = FISH.height + FISH.depthMargin;
const agentBoundX = P.width / 2 - 2, agentBoundZ = P.depth / 2 - 2;
let simTime = 0;

function waterDepthAt(x, z) { return water.level - sampleHeight(x, z); }

function fishNavigable(x, z) {
  if (Math.abs(x) > agentBoundX || Math.abs(z) > agentBoundZ) return false;
  return waterDepthAt(x, z) >= fishMinDepth;
}

/* True if (x, z) lies on a painted egg-laying zone cell. */
function inEggZone(x, z) {
  if (zoneCellCount === 0) return false;
  const ix = Math.round((x + P.width / 2) / dx);
  const iz = Math.round((z + P.depth / 2) / dz);
  if (ix < 0 || ix > T.segX || iz < 0 || iz > T.segZ) return false;
  return zoneMask[iz * NX + ix] > 0;
}

/* Multi-source BFS outward from every navigable zone cell over navigable
 * water (8-connected). Each reachable cell gets a layer count that strictly
 * decreases toward a zone, so greedy descent always finds a path — around
 * islands and barriers, not through them. */
const _flowQueue = new Int32Array(NX * NZ);
function nodeNavigable(ix, iz) {
  return fishNavigable(-P.width / 2 + ix * dx, -P.depth / 2 + iz * dz);
}
function computeFlowField() {
  flowDist.fill(Infinity);
  if (zoneCellCount === 0) return;
  let head = 0, tail = 0;
  for (let iz = 0; iz <= T.segZ; iz++) {
    for (let ix = 0; ix <= T.segX; ix++) {
      const idx = iz * NX + ix;
      if (zoneMask[idx] > 0 && nodeNavigable(ix, iz)) {
        flowDist[idx] = 0;
        _flowQueue[tail++] = idx;
      }
    }
  }
  while (head < tail) {
    const idx = _flowQueue[head++];
    const iz = (idx / NX) | 0, ix = idx - iz * NX;
    const nd = flowDist[idx] + 1;
    for (let dz2 = -1; dz2 <= 1; dz2++) {
      for (let dx2 = -1; dx2 <= 1; dx2++) {
        if (!dx2 && !dz2) continue;
        const nx = ix + dx2, nz = iz + dz2;
        if (nx < 0 || nx > T.segX || nz < 0 || nz > T.segZ) continue;
        const nidx = nz * NX + nx;
        if (flowDist[nidx] <= nd || !nodeNavigable(nx, nz)) continue;
        flowDist[nidx] = nd;
        _flowQueue[tail++] = nidx;
      }
    }
  }
}

/* Heading toward the zone from (x, z): the direction of the lowest-distance
 * neighbour. Returns null if this cell can't reach any zone. */
function flowHeadingAt(x, z) {
  const ix = Math.max(0, Math.min(T.segX, Math.round((x + P.width / 2) / dx)));
  const iz = Math.max(0, Math.min(T.segZ, Math.round((z + P.depth / 2) / dz)));
  const here = flowDist[iz * NX + ix];
  if (!isFinite(here)) return null;
  let best = here, bx = 0, bz = 0;
  for (let dz2 = -1; dz2 <= 1; dz2++) {
    for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dz2) continue;
      const nx = ix + dx2, nz = iz + dz2;
      if (nx < 0 || nx > T.segX || nz < 0 || nz > T.segZ) continue;
      const d = flowDist[nz * NX + nx];
      if (d < best) { best = d; bx = dx2; bz = dz2; }
    }
  }
  if (bx === 0 && bz === 0) return null;
  return Math.atan2(bz, bx);
}

function spawnFish(x, z, opts = {}) {
  if (agentCount() >= AGENT_CAP) return;
  const color = opts.color ? new THREE.Color(opts.color) : randomFishColor();
  const { mesh, st } = createAgent('fish', BREED_F, fishGeo, fishMat, {
    mode: 'swim',          // 'swim' | 'beached'
    vel: new THREE.Vector3(),
    flopTimer: 0.4,
    grounded: false,
    seekTime: 0,           // how long it's been trying to reach the zone
    pitch: 0,              // nose-up/down angle for 3D swimming
    color,                 // genetic color trait
  }, !!opts.newborn, color);
  if (fishNavigable(x, z)) {
    mesh.position.set(
      x,
      Math.max(sampleHeight(x, z) + FISH.height / 2 + 0.1, water.level - FISH.surfaceMargin - Math.random() * Math.max(0, water.level - sampleHeight(x, z) - FISH.height - FISH.surfaceMargin)),
      z
    );
  } else {
    st.mode = 'beached'; // placed on land: it falls, then flops for water
    mesh.position.set(x, sampleHeight(x, z) + FISH.height / 2 + 1.5, z);
  }
  fishes.push({ mesh, st });
  updateCreatureReadout();
}

/* Random spawn into comfortably deep water (beached at centre if none). */
function spawnFishRandom() {
  for (let i = 0; i < 600; i++) {
    const x = (Math.random() - 0.5) * (P.width - 5);
    const z = (Math.random() - 0.5) * (P.depth - 5);
    if (waterDepthAt(x, z) >= fishMinDepth + 0.3) { spawnFish(x, z); return; }
  }
  spawnFish(0, 0);
}

/* Orient an agent box: long axis along heading, up along `normal`
 * (terrain slope when grounded, world-up otherwise), with an
 * optional roll wobble. Shared by the fish and all land agents. */
const _fq = new THREE.Quaternion(), _fm = new THREE.Matrix4();
const _fx = new THREE.Vector3(), _fy = new THREE.Vector3(), _fz = new THREE.Vector3();
const _froll = new THREE.Quaternion(), _xAxis = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
/* Fish-specific orientation with pitch baked into the forward vector so
 * the mesh tilts nose-down when diving and nose-up when ascending. */
function orientFish(mesh, heading, pitch, dt) {
  _fx.set(Math.cos(heading) * Math.cos(pitch), Math.sin(pitch), Math.sin(heading) * Math.cos(pitch)).normalize();
  _fy.set(0, 1, 0);
  _fz.crossVectors(_fx, _fy).normalize();
  _fy.crossVectors(_fz, _fx); // recompute up from forward × right
  _fm.makeBasis(_fx, _fy, _fz);
  _fq.setFromRotationMatrix(_fm);
  mesh.quaternion.slerp(_fq, Math.min(1, dt * 10));
}

function orientAgent(mesh, heading, normal, wobble, dt) {
  _fy.copy(normal).normalize();
  _fx.set(Math.cos(heading), 0, Math.sin(heading));
  _fx.addScaledVector(_fy, -_fx.dot(_fy)).normalize(); // project heading onto surface
  _fz.crossVectors(_fx, _fy);
  _fm.makeBasis(_fx, _fy, _fz);
  _fq.setFromRotationMatrix(_fm);
  if (wobble) _fq.multiply(_froll.setFromAxisAngle(_xAxis, wobble));
  mesh.quaternion.slerp(_fq, Math.min(1, dt * 10));
}

/* Surface-swimmer steering: re-aim toward the shallowest direction on an
 * interval. Probes at two ranges so a distant shore still produces a
 * gradient, and keeps the current heading on near-ties so open-water
 * swimming is committed, not a dithering random walk. Shared by the
 * swamped frog and the swimming bird. */
function steerTowardShallows(p, st, dt) {
  st.paddleTimer -= dt;
  if (st.paddleTimer > 0) return;
  const score = (ang) => {
    const x1 = p.x + Math.cos(ang) * 8,  z1 = p.z + Math.sin(ang) * 8;
    const x2 = p.x + Math.cos(ang) * 24, z2 = p.z + Math.sin(ang) * 24;
    if (Math.abs(x1) > agentBoundX || Math.abs(z1) > agentBoundZ) return Infinity;
    const cx2 = Math.max(-agentBoundX, Math.min(agentBoundX, x2));
    const cz2 = Math.max(-agentBoundZ, Math.min(agentBoundZ, z2));
    return waterDepthAt(x1, z1) + waterDepthAt(cx2, cz2) * 0.5;
  };
  const current = score(st.heading);
  let best = st.heading, bestD = current;
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    const d = score(ang) + (Math.random() - 0.5) * 0.1;
    if (d < bestD - 0.08) { bestD = d; best = ang; } // must clearly beat current
  }
  st.heading = best;
  st.paddleTimer = 0.4;
}

/* One flop: lurch toward the deepest nearby water (downhill when dry). */
function fishFlop(a) {
  const p = a.mesh.position, st = a.st;
  let best = st.heading, bestD = -Infinity;
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    const d = waterDepthAt(p.x + Math.cos(ang) * 5, p.z + Math.sin(ang) * 5)
            + (Math.random() - 0.5) * 0.2; // jitter so it doesn't railroad
    if (d > bestD) { bestD = d; best = ang; }
  }
  st.heading = best;
  const h = FISH.flopHoriz * (0.7 + Math.random() * 0.6);
  st.vel.set(Math.cos(best) * h, FISH.flopVert * (0.8 + Math.random() * 0.4), Math.sin(best) * h);
  st.flopTimer = 0.5 + Math.random() * 0.8;
}

function swimTick(a, dt) {
  const p = a.mesh.position, st = a.st;

  // Lost the water under it (sculpted up / level dropped) -> beach.
  if (!fishNavigable(p.x, p.z)) {
    st.mode = 'beached';
    st.vel.set(0, 0, 0);
    st.flopTimer = 0.4;
    return;
  }

  // Grazing/hunting takes priority over breeding when the reserve is low.
  const graze = grazeControl(a, dt, {
    plant: plantInWater,
    use3D: true,
  });
  predationContactStep(a); // aquatic predators (piranha, black_caiman) catch live prey via DIETS

  // --- Steering: yaw + pitch are the only movement controls ---
  const SR = FISH.steerRate;
  let seeking = false;

  // Aquatic ambush predator (cfg.ambush, e.g. caiman): when hungry, stalk the
  // nearest reachable prey instead of drifting/grazing — steer toward its
  // bearing (the fish navigability clamp keeps it in water, so it hugs the bank
  // nearest the prey) and sink low to lurk. The wide contactRadius strike then
  // lands across the shallow margin. Overrides the plant/idle steering below.
  let stalkHeading = null;
  if ((predCfg(st.species) || {}).ambush &&
      st.maxHunger && st.hunger <= GRAZE.threshold * st.maxHunger) {
    const pr = seekNearestPrey(a, FISH.lookAhead * 4);
    if (pr) stalkHeading = pr.heading;
  }

  if (stalkHeading !== null) {
    st.heading += angDiff(stalkHeading, st.heading) * Math.min(1, dt * SR);
    st.pitch   += angDiff(-0.12, st.pitch) * Math.min(1, dt * SR); // lurk low
    seeking = true;
  } else if (graze === 'eat') {
    // Hold station: face the food, bob, don't advance.
    st.heading += angDiff(st.grazeHeading, st.heading) * Math.min(1, dt * SR);
    st.pitch += (0 - st.pitch) * Math.min(1, dt * SR);
    p.y += eatBob(st, FISH.height);
    orientFish(a.mesh, st.heading, st.pitch, dt);
    return;
  } else if (graze === 'move') {
    // Steer yaw toward food's XZ bearing.
    st.heading += angDiff(st.grazeHeading, st.heading) * Math.min(1, dt * SR);
    // Steer pitch toward food's 3D elevation angle.
    if (st.forage) {
      const fp = foragePos(st.forage);
      const fy = forageY(st.forage);
      const dx = fp.x - p.x, dz = fp.z - p.z;
      const hDist = Math.sqrt(dx * dx + dz * dz) + 0.01;
      const desiredPitch = Math.atan2(fy - p.y, hDist);
      const targetPitch = Math.max(-FISH.pitchMax, Math.min(FISH.pitchMax, desiredPitch));
      st.pitch += angDiff(targetPitch, st.pitch) * Math.min(1, dt * SR);
    }
    seeking = true;
  } else {
    // Not foraging: breeding / idle wander.
    const wantsToLay = st.mature && st.layTimer <= 0 && canReproduce(st, BREED_F.layCost);
    const doLay = () => { layEgg(a); payReproCost(st, BREED_F.layCost); st.layTimer = randomLayInterval(BREED_F); };
    if (wantsToLay) {
      if (zoneCellCount === 0) {
        doLay();
      } else if (inEggZone(p.x, p.z)) {
        doLay();
        st.seekTime = 0;
      } else {
        const fh = flowHeadingAt(p.x, p.z);
        st.seekTime += dt;
        if (fh !== null) {
          st.heading += angDiff(fh, st.heading) * Math.min(1, dt * SR);
          seeking = true;
        }
        if (st.seekTime > BREED_F.seekTimeout) {
          doLay();
          st.seekTime = 0;
        }
      }
    } else {
      st.seekTime = 0;
    }
    // Random wander on both axes when not steering toward anything.
    if (!seeking) {
      st.heading += (Math.random() - 0.5) * FISH.yawNoise * dt;
      st.pitch   += (Math.random() - 0.5) * FISH.pitchNoise * dt;
    }
  }

  // --- Boundary avoidance: pitch + yaw corrections ---
  const floor = sampleHeight(p.x, p.z) + FISH.height / 2 + 0.1;
  const ceil  = water.level - FISH.surfaceMargin;

  // Pitch away from floor and surface.
  if (p.y < floor + 0.5 && st.pitch < 0) st.pitch += dt * SR * 2;
  if (p.y > ceil  - 0.5 && st.pitch > 0) st.pitch -= dt * SR * 2;

  // Clamp pitch.
  st.pitch = Math.max(-FISH.pitchMax, Math.min(FISH.pitchMax, st.pitch));

  // Yaw obstacle avoidance: probe ahead in XZ; if blocked, fan out.
  const probeBlocked = (ang) => !fishNavigable(
    p.x + Math.cos(ang) * FISH.lookAhead,
    p.z + Math.sin(ang) * FISH.lookAhead
  );
  if (probeBlocked(st.heading)) {
    const offsets = [0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4, Math.PI];
    for (const o of offsets) {
      if (!probeBlocked(st.heading + o)) { st.heading += o; break; }
    }
  }

  // --- Advance along the 3D forward vector ---
  const cosPitch = Math.cos(st.pitch);
  const sinPitch = Math.sin(st.pitch);
  const vx = Math.cos(st.heading) * cosPitch * FISH.speed * dt;
  const vy = sinPitch * FISH.speed * dt;
  const vz = Math.sin(st.heading) * cosPitch * FISH.speed * dt;

  const nx = p.x + vx;
  const nz = p.z + vz;
  let   ny = p.y + vy;

  // Hard clamp: stay in navigable water and between floor and surface.
  if (fishNavigable(nx, nz)) { p.x = nx; p.z = nz; }
  const floorHere = sampleHeight(p.x, p.z) + FISH.height / 2 + 0.1;
  const ceilHere  = water.level - FISH.height / 2 - 0.1;
  p.y = Math.max(floorHere, Math.min(ceilHere, ny));

  orientFish(a.mesh, st.heading, st.pitch, dt);
}

function beachedTick(a, dt) {
  const p = a.mesh.position, st = a.st, v = st.vel;

  // Ballistic integration with gravity.
  v.y -= FISH.gravity * dt;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;

  // Fence containment: stop dead at the walls.
  if (Math.abs(p.x) > agentBoundX) { p.x = Math.sign(p.x) * agentBoundX; v.x = 0; }
  if (Math.abs(p.z) > agentBoundZ) { p.z = Math.sign(p.z) * agentBoundZ; v.z = 0; }

  // Full land contact against the heightfield.
  const groundY = sampleHeight(p.x, p.z) + FISH.height / 2 + 0.02;
  if (p.y <= groundY) {
    p.y = groundY;
    if (v.y < 0) v.y = 0;
    const fr = Math.max(0, 1 - dt * 8); // ground friction kills the slide
    v.x *= fr; v.z *= fr;
    st.grounded = true;
  } else {
    st.grounded = false;
  }

  // Back in swimmable water (with hysteresis) -> dive and resume.
  if (waterDepthAt(p.x, p.z) >= fishMinDepth + 0.05 &&
      Math.abs(p.x) <= agentBoundX && Math.abs(p.z) <= agentBoundZ) {
    st.mode = 'swim';
    st.pitch = 0;
    return;
  }

  // Grounded: wait out the flop timer, then lurch toward water.
  if (st.grounded) {
    st.flopTimer -= dt;
    if (st.flopTimer <= 0) fishFlop(a);
  }

  // Seat to the slope when grounded; thrash-roll while airborne
  // (per-agent phase so a pile of beached fish doesn't sync up).
  const normal = st.grounded ? terrainNormalAt(p.x, p.z) : UP;
  const wobble = st.grounded ? 0 : Math.sin(simTime * 22 + p.x * 3) * 0.45;
  orientAgent(a.mesh, st.heading, normal, wobble, dt);
}

function fishTick(dt) {
  simTime += dt;

  // Recompute the breeding flow field when dirty, throttled.
  flowAccum += dt;
  if (flowDirty && flowAccum >= 0.25) {
    computeFlowField();
    flowDirty = false;
    flowAccum = 0;
  }

  for (const a of fishes) {
    const st = a.st;
    if (st.dead) continue; // corpse: handled by the decay pass
    if (st.aiSuspended) continue;

    maturationStep(a, BREED_F, dt);
    (st.mode === 'swim' ? swimTick : beachedTick)(a, dt);

    // Lay clock only advances once mature; laying itself happens in swimTick
    // (so it can route to the egg zone first). Clamp so it doesn't run away.
    if (st.mature && st.layTimer > -BREED_F.seekTimeout) st.layTimer -= dt;
  }
}

/* ============================================================
 * EGGS  —  fish reproduction: lay -> fertilize -> incubate -> hatch.
 *
 * An egg is laid unfertilized at the parent's position and
 * settles (lakebed if submerged, terrain otherwise). It
 * fertilizes when a *different* fish passes within range, gated
 * by fertSuccessRate. Once fertilized it incubates, then hatches
 * a new fish. Unfertilized eggs lie dormant indefinitely unless
 * unfertLifespan is set.
 * ============================================================ */
/* Per-species egg appearance. radius is the sphere radius (fish = 0.15);
 * fertilized eggs keep the base colour but gain an emissive glow as the
 * "alive" cue. Add a species here to give its eggs a distinct look; any
 * species missing falls back to the fish style. */
const EGG_STYLE = {
  fish:    { radius: 0.15,  color: 0xcc6611, fertColor: 0xe87a14, fertEmissive: 0xaa4400 }, // orange
  frog:    { radius: 0.15,  color: 0x111111, fertColor: 0x2a2a2a, fertEmissive: 0x4a7a3a }, // black, green glow
  insect:  { radius: 0.075, color: 0x111111, fertColor: 0x2a2a2a, fertEmissive: 0x7a5a2a }, // small black, amber glow
};
const _eggAssets = {};
function eggAssets(species) {
  if (_eggAssets[species]) return _eggAssets[species];
  const s = EGG_STYLE[species] || EGG_STYLE.fish;
  const seg = Math.max(8, Math.min(20, Math.round(s.radius * 12)));
  const assets = {
    radius: s.radius,
    geo: new THREE.SphereGeometry(s.radius, seg, Math.max(6, Math.round(seg * 0.8))),
    matUnfert: new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.7, metalness: 0 }),
    matFert: new THREE.MeshStandardMaterial({
      color: s.fertColor, emissive: s.fertEmissive, emissiveIntensity: 0.8, roughness: 0.4,
    }),
  };
  return _eggAssets[species] = assets;
}

/* Rest height: the egg sits its own radius above the surface (lakebed or land). */
function eggRestY(x, z, r) {
  return sampleHeight(x, z) + r;
}

function layEgg(parent) {
  if (eggs.length + agentCount() >= AGENT_CAP) return;
  const p = parent.mesh.position;
  const x = p.x, z = p.z;
  const assets = eggAssets(parent.st.species);
  const mesh = new THREE.Mesh(assets.geo, assets.matUnfert);
  mesh.castShadow = true;
  mesh.position.set(x, eggRestY(x, z, assets.radius), z);
  platformGroup.add(mesh);
  eggs.push({
    mesh,
    assets,
    st: {
      species: parent.st.species, // determines who fertilizes it and what it hatches
      radius: assets.radius,
      fertilized: false,
      parentId: parent.st.id,     // the layer can't fertilize its own egg
      layerColor: parent.st.color, // genetic color of the laying parent (fish)
      age: 0,                     // time since laid (for unfert cleanup)
      incubation: 0,              // time since fertilization
      fertCooldown: 0,            // retry gate after a failed roll
    },
  });
  updateCreatureReadout();
}

function eggTick(dt) {
  for (let i = eggs.length - 1; i >= 0; i--) {
    const e = eggs[i], st = e.st, p = e.mesh.position;
    const reg = SPECIES[st.species];
    const br = reg.br;

    // Keep the egg seated as terrain/water changes underneath it.
    p.y += (eggRestY(p.x, p.z, st.radius) - p.y) * Math.min(1, dt * 6);

    if (!st.fertilized) {
      st.age += dt;
      st.fertCooldown -= dt;

      // Optional cleanup of stale unfertilized eggs.
      if (br.unfertLifespan > 0 && st.age >= br.unfertLifespan) {
        platformGroup.remove(e.mesh);
        eggs.splice(i, 1);
        updateCreatureReadout();
        continue;
      }

      // Fertilization: a *different*, mature, living same-species individual
      // passing within range, gated by the species' success rate.
      if (st.fertCooldown <= 0) {
        const r2 = br.fertRadius * br.fertRadius;
        for (const c of reg.list) {
          if (c.st.id === st.parentId) continue;       // not the layer
          if (c.st.species !== st.species) continue;   // shared bird array: match type
          if (c.st.dead || !c.st.mature) continue;     // must be a living adult
          if (!canReproduce(c.st, br.fertCost)) continue; // too starved to afford fertilizing
          const cp = c.mesh.position;
          const dx = cp.x - p.x, dz = cp.z - p.z, dy = cp.y - p.y;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            if (Math.random() < br.fertSuccessRate) {
              st.fertilized = true;
              st.fertColor = c.st.color; // genetic color of the fertilizing parent (fish)
              e.mesh.material = e.assets.matFert;
              payReproCost(c.st, br.fertCost); // fertilizing costs the passer energy
            } else {
              st.fertCooldown = br.fertCooldown; // wait before retrying
            }
            break; // one encounter per tick
          }
        }
      }
    } else {
      // Incubating -> hatch into a newborn of the egg's species.
      st.incubation += dt;
      if (st.incubation >= br.eggIncubation) {
        const hx = p.x, hz = p.z;
        platformGroup.remove(e.mesh);
        eggs.splice(i, 1);
        const spawnOpts = { newborn: true };
        if (st.layerColor && st.fertColor) spawnOpts.color = mixFishColor(st.layerColor, st.fertColor);
        reg.spawn(hx, hz, spawnOpts);
        updateCreatureReadout();
      }
    }
  }
}

/* ============================================================
 * VEGETATION  —  plants as instanced spheres that grow and
 * darken with age. Sprayed by the Plant brush; density controls
 * spacing, radius the placement area. Each plant ages from a
 * small light-green sprout to a larger dark-green mature plant.
 *
 * One InstancedMesh (per-instance scale + color) keeps thousands
 * of plants to a single draw call; a coarse spatial hash makes
 * spray-spacing checks cheap.
 * ============================================================ */
const VEG = CONFIG.vegetation;

/* Plant rendering: one InstancedMesh per GEOMETRY ("veg layer"), so species can
 * have different models. Each plant lives in its species' layer at index pl.idx
 * AND in the global `plants` array at pl.gidx (both swap-removed in O(1)). A
 * single shared material (vertexColors) lets a model bake a base->tip gradient
 * while each plant's instanceColor carries the species' young->lush tint. */

// Sphere model (the original look) — fallback for species without a bespoke
// model. White colour attribute so it works with the shared vertexColors mat.
function makeVegSphereGeo() {
  const g = new THREE.SphereGeometry(1, 8, 6);
  const col = new Float32Array(g.attributes.position.count * 3).fill(1);
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// Low-poly BUSH model: a clump of icosahedron foliage blobs, base at y=0,
// ~unit footprint and ~1.3 tall (scaled per plant by its food-driven radius).
// Vertex colours bake a darker-base / brighter-top gradient (x species tint).
// ~120 tris — squarely in the stylized game-art low-poly range.
function makeVegBushGeo() {
  const blobs = [ // x, y, z, radius
    [ 0.00, 0.60,  0.00, 0.55], [-0.42, 0.40,  0.12, 0.40], [ 0.40, 0.44, -0.10, 0.42],
    [ 0.10, 0.40,  0.42, 0.38], [-0.12, 0.36, -0.40, 0.36], [ 0.00, 0.92,  0.00, 0.34],
  ];
  const pos = [], nor = [], col = [];
  for (const [bx, by, bz, br] of blobs) {
    const g = new THREE.IcosahedronGeometry(br, 0).toNonIndexed();
    const p = g.attributes.position, nm = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const vy = p.getY(i) + by;
      pos.push(p.getX(i) + bx, vy, p.getZ(i) + bz);
      nor.push(nm.getX(i), nm.getY(i), nm.getZ(i));
      const shade = 0.5 + 0.6 * Math.min(1, vy / 1.25); // darker base -> brighter top
      col.push(shade, shade, shade);
    }
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

// Low-poly TREE model: a tapered trunk + a clump of canopy blobs above it, base
// at y=0, ~2.5 tall in unit space (taller than wide, so uniform scale-by-food
// keeps tree proportions). Unlike the all-green bush, the tree bakes its OWN
// colours (brown trunk, green canopy gradient); the species tint stays ~white.
function makeVegTreeGeo() {
  const pos = [], nor = [], col = [];
  const append = (g, ox, oy, oz, shade) => {
    const ng = g.toNonIndexed(), p = ng.attributes.position, nm = ng.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const vy = p.getY(i) + oy;
      pos.push(p.getX(i) + ox, vy, p.getZ(i) + oz);
      nor.push(nm.getX(i), nm.getY(i), nm.getZ(i));
      col.push(...shade(vy));               // baked RGB, per vertex
    }
    ng.dispose(); g.dispose();
  };
  // Trunk: short tapered cylinder, base at y=0.
  const trunkH = 1.35;
  const trunk = new THREE.CylinderGeometry(0.10, 0.15, trunkH, 6, 1);
  trunk.translate(0, trunkH / 2, 0);
  append(trunk, 0, 0, 0, () => [0.40, 0.27, 0.16]); // bark brown
  // Canopy: green foliage blobs above the trunk, brighter toward the crown.
  const canopy = [ // x, y, z, radius
    [ 0.00, 1.80,  0.00, 0.74], [-0.52, 1.52,  0.18, 0.50], [ 0.52, 1.56, -0.12, 0.52],
    [ 0.14, 1.50,  0.50, 0.48], [-0.16, 2.10, -0.10, 0.45],
  ];
  const canopyShade = (vy) => {
    const t = Math.max(0, Math.min(1, (vy - 1.0) / 1.3));
    return [0.12 + 0.10 * t, 0.40 + 0.32 * t, 0.12 + 0.06 * t]; // green, brighter up top
  };
  for (const [bx, by, bz, br] of canopy) append(new THREE.IcosahedronGeometry(br, 0), bx, by, bz, canopyShade);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

const vegMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, vertexColors: true });
// Geometry templates + the species -> geometry mapping. Add entries as more
// species get bespoke models; anything unmapped falls back to the sphere.
const VEG_GEO = {
  sphere: { geom: makeVegSphereGeo(), originBase: false }, // centred (y = ground + r)
  bush:   { geom: makeVegBushGeo(),   originBase: true  }, // base on the ground (y = ground)
  tree:   { geom: makeVegTreeGeo(),   originBase: true  }, // trunk base on the ground
};
const PLANT_MODEL = { plant: 'bush', tree: 'tree' }; // species id -> geometry key
const vegLayers = {};                  // geometry key -> { key, mesh, cap, list, originBase }

function vegLayerFor(sp) {
  const key = PLANT_MODEL[sp.id] || 'sphere';
  let L = vegLayers[key];
  if (!L) {
    const def = VEG_GEO[key];
    const mesh = new THREE.InstancedMesh(def.geom, vegMat, 256);
    mesh.count = 0; mesh.castShadow = true; mesh.frustumCulled = false;
    platformGroup.add(mesh);
    L = vegLayers[key] = { key, mesh, cap: 256, list: [], originBase: def.originBase };
  }
  return L;
}
function markVegLayer(L) {
  L.mesh.instanceMatrix.needsUpdate = true;
  if (L.mesh.instanceColor) L.mesh.instanceColor.needsUpdate = true;
}
function flushVegLayers() { for (const k in vegLayers) markVegLayer(vegLayers[k]); }

/* Grow a layer's instance buffer (a fixed GPU allocation) by doubling, then
 * re-derive every instance from the layer's plant list. */
function growVegLayer(L, need) {
  let cap = L.cap; while (cap < need) cap *= 2;
  const next = new THREE.InstancedMesh(L.mesh.geometry, vegMat, cap);
  next.count = L.list.length; next.castShadow = true; next.frustumCulled = false; next.visible = L.mesh.visible;
  platformGroup.add(next); platformGroup.remove(L.mesh);
  const old = L.mesh; L.mesh = next; L.cap = cap;
  for (let i = 0; i < L.list.length; i++) writePlantInstance(L, i, L.list[i]);
  markVegLayer(L);
  old.dispose();
}

/* Swap a layer's geometry in place (e.g. procedural -> imported GLB), keeping
 * its plants. Re-derives every instance into a fresh InstancedMesh. */
function rebuildVegLayerGeom(L, geom) {
  const next = new THREE.InstancedMesh(geom, vegMat, L.cap);
  next.count = L.list.length; next.castShadow = true; next.frustumCulled = false; next.visible = L.mesh.visible;
  platformGroup.add(next); platformGroup.remove(L.mesh);
  const old = L.mesh; L.mesh = next;
  for (let i = 0; i < L.list.length; i++) writePlantInstance(L, i, L.list[i]);
  markVegLayer(L);
  old.dispose();
}

/* Upscale the procedural 'tree' to a hand-authored low-poly GLB (assets/models/
 * tree_lowpoly.glb, built by tools/make_tree_glb.py). It's a single static
 * vertex-coloured mesh, so its geometry drops straight into the instanced
 * vegetation renderer. Loaded async; the procedural tree stands in until ready. */
new GLTFLoader().load('assets/models/tree_lowpoly.glb', (gltf) => {
  let geom = null;
  gltf.scene.traverse(o => { if (o.isMesh && !geom) geom = o.geometry; });
  if (!geom) return;
  VEG_GEO.tree.geom = geom;                                       // new tree layers use it
  if (vegLayers.tree) rebuildVegLayerGeom(vegLayers.tree, geom);  // swap any existing trees
}, undefined, (e) => console.warn('tree GLB load failed; using procedural tree', e));

const plants = [];                 // { x, z, age, grown, food, ... }

/* ---- Plant species registry --------------------------------------------
 * Like creatures, plants are data-driven. Each plant species carries its own
 * young->lush color gradient, full size, and habitat rules (where it may
 * germinate and where it may grow). All of them — including the default green
 * shore flora ("plant", in config/species/plant.json) — are registered from
 * JSON via registerSpecies(); shared plant mechanics stay in world.js. */
const PLANT_SPECIES = {};
const PLANT_SERIES  = []; // chart series (right axis), one per plant species
function registerPlantSpecies(def) {
  PLANT_SPECIES[def.id] = def;
  PLANT_SERIES.push({ key: def.id, label: def.label, color: def.chartColor });
}
const _vegM4 = new THREE.Matrix4();
const _vegColor = new THREE.Color();
const _vegPos = new THREE.Vector3();    // rustle composition temps
const _vegQuat = new THREE.Quaternion();
const _vegScale = new THREE.Vector3();
let sunlight = 1; // global multiplier on food regrowth (hook for future day/night)

// Spatial hash for spacing checks (cell >= max spacing so 3x3 covers any query).
const vegCell = VEG.spaceSparse;
const vegGrid = new Map();
const vegKey = (cx, cz) => cx + ',' + cz;
function vegNear(x, z, spacing) {
  const cx = Math.floor(x / vegCell), cz = Math.floor(z / vegCell);
  const s2 = spacing * spacing;
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      const arr = vegGrid.get(vegKey(cx + dc, cz + dr));
      if (!arr) continue;
      for (const pl of arr) {
        const ex = pl.x - x, ez = pl.z - z;
        if (ex * ex + ez * ez < s2) return true;
      }
    }
  }
  return false;
}

function writePlantInstance(L, i, pl) {
  // Food level is the plant's lushness: 1/10 = small & light green (stripped),
  // 10/10 = large & dark green (lush). pl.maxR is the plant's fixed full size
  // (a genetic trait set at birth), so the slider never resizes living plants.
  const foodFrac = pl.food / VEG.maxFood;
  const r = VEG.minRadius + (pl.maxR - VEG.minRadius) * foodFrac;
  const baseY = sampleHeight(pl.x, pl.z);
  _vegM4.makeScale(r, r, r);
  // base-origin models (bush) sit ON the surface; centred models (sphere) rest +r.
  _vegM4.setPosition(pl.x, L.originBase ? baseY : baseY + r, pl.z);
  L.mesh.setMatrixAt(i, _vegM4);
  _vegColor.copy(pl.sp.young).lerp(pl.sp.old, foodFrac);
  L.mesh.setColorAt(i, _vegColor);
  pl.shownFood = pl.food; // change-detection baseline for vegVisualTick
}

/* The eaten-plant shake: a quick scale-pulse + horizontal sway. Size tracks food. */
function writePlantRustle(L, i, pl) {
  const foodFrac = pl.food / VEG.maxFood;
  const baseR = VEG.minRadius + (pl.maxR - VEG.minRadius) * foodFrac;
  const ph = (pl.rustlePhase || 0) * RUSTLE.rate;
  const pulse = Math.sin(ph) * RUSTLE.squash;
  const sx = baseR * (1 + pulse + RUSTLE.scaleAmp * Math.abs(Math.sin(ph * 0.5)));
  const sz = baseR * (1 - pulse + RUSTLE.scaleAmp * Math.abs(Math.sin(ph * 0.5)));
  const sy = baseR * (1 - 0.5 * pulse);
  const jx = Math.sin(ph * 1.7) * baseR * RUSTLE.swayFrac;
  const jz = Math.cos(ph * 1.3) * baseR * RUSTLE.swayFrac;
  const baseY = sampleHeight(pl.x, pl.z);
  _vegPos.set(pl.x + jx, L.originBase ? baseY : baseY + sy, pl.z + jz);
  _vegQuat.identity();
  _vegScale.set(sx, sy, sz);
  _vegM4.compose(_vegPos, _vegQuat, _vegScale);
  L.mesh.setMatrixAt(i, _vegM4);
  _vegColor.copy(pl.sp.young).lerp(pl.sp.old, foodFrac);
  L.mesh.setColorAt(i, _vegColor);
}

function addPlant(x, z, food = VEG.startFood, sp = PLANT_SPECIES.plant) {
  // Soil carrying capacity: a patch that's full won't let anything else
  // germinate (this gates the procedural fill, seed dispersal, and the brush).
  const soilPi = soilPatchIndex(x, z);
  if (soilLoad[soilPi] + food > soilCap[soilPi]) return false;
  const L = vegLayerFor(sp);
  if (L.list.length >= L.cap) growVegLayer(L, L.list.length + 1); // expand, never reject
  const cellKey = vegKey(Math.floor(x / vegCell), Math.floor(z / vegCell));
  // Roll a fixed full size: 60%-100% of this species' max AT BIRTH. This "gene"
  // stays with the plant for life — later slider changes only affect new plants.
  const maxR = Math.max(VEG.minRadius, sp.maxR * (0.6 + Math.random() * 0.4));
  const pl = { x, z, food, idx: L.list.length, gidx: plants.length, cellKey, eaten: false, maxR, sp, soil: soilPi, layer: L };
  soilLoad[soilPi] += food; // track biomass in this patch
  plants.push(pl);
  L.list.push(pl);
  writePlantInstance(L, pl.idx, pl);
  L.mesh.count = L.list.length;
  markVegLayer(L);
  let arr = vegGrid.get(cellKey);
  if (!arr) vegGrid.set(cellKey, arr = []);
  arr.push(pl);
  return true;
}

/* Swap-remove a plant from both its render layer and the global array. */
function removePlant(pl) {
  if (pl.eaten) return;
  pl.eaten = true;
  if (pl.soil != null) soilLoad[pl.soil] = Math.max(0, soilLoad[pl.soil] - pl.food); // biomass leaves the patch
  const cellArr = vegGrid.get(pl.cellKey);
  if (cellArr) {
    const j = cellArr.indexOf(pl);
    if (j >= 0) cellArr.splice(j, 1);
  }
  // Render layer: move the layer's last plant into the freed instance slot.
  const L = pl.layer, vi = pl.idx;
  const lastL = L.list.pop();
  if (lastL !== pl) { L.list[vi] = lastL; lastL.idx = vi; writePlantInstance(L, vi, lastL); }
  L.mesh.count = L.list.length;
  markVegLayer(L);
  // Global array: independent swap-remove keyed by gidx.
  const gi = pl.gidx;
  const lastG = plants.pop();
  if (lastG !== pl) { plants[gi] = lastG; lastG.gidx = gi; }
  document.getElementById('r-plants').textContent = plants.length;
}

/* ---- Procedural vegetation layer (runs with "Generate island") ----------
 * Density is a function of TRUE distance to the waterline (a BFS field, so
 * a flat inland plateau doesn't masquerade as shore), shaped to peak along
 * coastlines and fade to a sparse floor at the most inland points, then
 * modulated by an independent clump noise so coverage forms natural groves
 * and clearings instead of a uniform ring. Shallow water near shore gets
 * its own band of aquatic plants — that's what the fish graze. */

function clearAllPlants() {
  for (const pl of plants) pl.eaten = true; // grazers drop stale targets next check
  plants.length = 0;
  soilLoad.fill(0); // no biomass anywhere until the new layer seeds in
  vegGrid.clear();
  for (const k in vegLayers) { const L = vegLayers[k]; L.list.length = 0; L.mesh.count = 0; markVegLayer(L); }
}

/* BFS distance-to-shoreline in grid cells, over the whole map (land AND
 * water sides). Seeds are cells whose wet/dry state differs from a
 * 4-neighbour. Returns null when there is no shoreline at all (fully
 * drained or fully flooded map). Reuses the flow-field queue scratch —
 * both BFS passes are synchronous and never interleave. */
const _shoreDist = new Float32Array(NX * NZ);
function computeShoreDist() {
  _shoreDist.fill(Infinity);
  let head = 0, tail = 0;
  for (let iz = 0; iz <= T.segZ; iz++) {
    for (let ix = 0; ix <= T.segX; ix++) {
      const idx = iz * NX + ix;
      const wet = heights[idx] < water.level;
      const boundary =
        (ix > 0      && (heights[idx - 1]  < water.level) !== wet) ||
        (ix < T.segX && (heights[idx + 1]  < water.level) !== wet) ||
        (iz > 0      && (heights[idx - NX] < water.level) !== wet) ||
        (iz < T.segZ && (heights[idx + NX] < water.level) !== wet);
      if (boundary) { _shoreDist[idx] = 0; _flowQueue[tail++] = idx; }
    }
  }
  if (tail === 0) return null;
  while (head < tail) {
    const idx = _flowQueue[head++];
    const iz = (idx / NX) | 0, ix = idx - iz * NX;
    const nd = _shoreDist[idx] + 1;
    for (let dz2 = -1; dz2 <= 1; dz2++) {
      for (let dx2 = -1; dx2 <= 1; dx2++) {
        if (!dx2 && !dz2) continue;
        const nx = ix + dx2, nz = iz + dz2;
        if (nx < 0 || nx > T.segX || nz < 0 || nz > T.segZ) continue;
        const nidx = nz * NX + nx;
        if (_shoreDist[nidx] <= nd) continue;
        _shoreDist[nidx] = nd;
        _flowQueue[tail++] = nidx;
      }
    }
  }
  return _shoreDist;
}

/* Vegetation density in [0, 1] at a world point, given the shore field. With a
 * water-habitat species, density lives in the water body (rising away from the
 * shore) instead of on land. */
function vegDensityAt(x, z, shoreDist, sp) {
  const G = CONFIG.vegGen;
  const h = sampleHeight(x, z);
  const wet = h < water.level;
  let d; // world-unit distance from the waterline
  if (shoreDist) {
    const ix = Math.min(T.segX, Math.max(0, Math.round((x + P.width / 2) / dx)));
    const iz = Math.min(T.segZ, Math.max(0, Math.round((z + P.depth / 2) / dz)));
    d = shoreDist[iz * NX + ix] * 0.5 * (dx + dz);
  } else {
    d = Math.abs(h - water.level) * 4; // no shoreline anywhere: height proxy
  }
  const water_ = sp && sp.habitat === 'water';
  // Shore shape. Land flora: full within coastBand, fading inland; a shorter
  // fade into shallow water. Water flora: nothing on land, rising from the
  // shoreline into deeper water (capped at deepReach).
  const s = water_
    ? (wet ? sstep(0, G.deepReach, d) : 0)
    : (wet ? 1 - sstep(0, G.deepReach, d) : 1 - sstep(G.coastBand, G.inlandReach, d));
  // Patchiness: independent noise channel off the same world seed, sharpened
  // so the layer reads as groves with clearings rather than even stippling.
  // Land/water channels decorrelate via a coordinate offset (the simplex perm
  // table is already seeded from worldSeed); remap the [-1,1] field to [0,1].
  const off = water_ ? 137.9 : 71.3;
  const n = fbm(x * G.clumpFreq + off, z * G.clumpFreq + off) * 0.5 + 0.5;
  const clump = Math.pow(Math.max(0, (n - 0.2) / 0.8), G.clumpBias);
  const dens = s * clump * vegLevel; // vegLevel: the setup menu's vegetation dial
  if (water_) return dens;           // water flora: no inland floor
  // Inland floor (land only): "least at an inland point", not zero — and the
  // floor stays clump-gated so deep inland gets lone stragglers, not stipple.
  return wet ? dens : Math.max(dens, G.minDensity * clump * vegLevel);
}

/* Re-seat plants after a terrain edit: instance writes are change-gated
 * (vegVisualTick), so a plant no longer self-heals its Y seat every frame.
 * Mark everything inside the edited world-space AABB; the settle branch
 * rewrites their rest pose on the next frame. */
function reseatPlantsIn(wx0, wz0, wx1, wz1) {
  const c0 = Math.floor(wx0 / vegCell), c1 = Math.floor(wx1 / vegCell);
  const r0 = Math.floor(wz0 / vegCell), r1 = Math.floor(wz1 / vegCell);
  for (let cc = c0; cc <= c1; cc++) {
    for (let rr = r0; rr <= r1; rr++) {
      const arr = vegGrid.get(vegKey(cc, rr));
      if (!arr) continue;
      for (const pl of arr) {
        if (pl.x >= wx0 && pl.x <= wx1 && pl.z >= wz0 && pl.z <= wz1) pl.settle = true;
      }
    }
  }
}

/* ============================================================
 * GRASS  —  instanced procedural blades, scattered by soil fertility.
 * Density and height rise with a patch's carrying capacity, so fertile
 * ground reads as lush green and barren/rocky ground stays bare. One
 * InstancedMesh (per-blade matrix + colour) is a single draw call for tens
 * of thousands of blades; wind sway is computed in the vertex shader.
 * ============================================================ */
const GRASS = CONFIG.grass;
const grassUniforms = { uTime: { value: 0 } };
let grassDirty = false; // a soil edit happened; rebuild the grass layer when the stroke ends
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// A blade: a short tapered, slightly forward-curved strip. Base at y=0, grows
// +Y, width along X, front toward +Z. Vertex colours bake a base->tip
// brightness gradient (multiplied by each tuft's per-instance colour).
function makeBladeGeometry() {
  const segs = 3, w = GRASS.bladeW, h = GRASS.bladeH, bend = h * 0.12;
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const hw = w * 0.5 * (1 - t * 0.85);  // taper toward a point
    const y = h * t, z = bend * t * t;    // gentle forward curve
    const shade = 0.6 + 0.7 * t;          // darker base, brighter tip
    pos.push(-hw, y, z, hw, y, z);
    col.push(shade, shade, shade, shade, shade, shade);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const grassMat = new THREE.MeshStandardMaterial({
  vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
});
grassMat.onBeforeCompile = (sh) => {
  sh.uniforms.uTime = grassUniforms.uTime;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float gK = transformed.y / ${GRASS.bladeH.toFixed(3)}; gK = gK * gK; // tips sway most
        float gPh = uTime * ${GRASS.windSpeed.toFixed(3)} + instanceMatrix[3].x * 0.5 + instanceMatrix[3].z * 0.5;
        transformed.x += sin(gPh) * ${GRASS.wind.toFixed(3)} * gK;
        transformed.z += cos(gPh * 0.7) * ${(GRASS.wind * 0.6).toFixed(3)} * gK;
      #endif`);
};

let grassMesh = new THREE.InstancedMesh(makeBladeGeometry(), grassMat, GRASS.maxBlades);
grassMesh.count = 0;
grassMesh.frustumCulled = false;
grassMesh.castShadow = false;
grassMesh.receiveShadow = false;
platformGroup.add(grassMesh);

const _grassObj = new THREE.Object3D();
const _grassCol = new THREE.Color();
const _grassDry = new THREE.Color(GRASS.dryColor);
const _grassLush = new THREE.Color(GRASS.lushColor);
const soilFertAt = (x, z) => soilCap[soilPatchIndex(x, z)] / SOIL.maxCap; // normalized [0,~1]

/* Rebuild the whole grass layer from the current fertility field. Runs with
 * world generation (after soil capacity is derived). */
function generateGrass() {
  grassDirty = false;
  if (!GRASS.enabled) { grassMesh.count = 0; return; }
  // Each scatter point gets its OWN rng seeded by (worldSeed, k) — so the layout
  // is deterministic and per-point independent. Editing soil capacity in one
  // area changes only the points that fall there; everywhere else regenerates
  // pixel-identical, so a brush edit doesn't reshuffle the whole field.
  const baseSeed = (Math.floor(worldSeed * 100000) >>> 0) || 1;
  let n = 0;
  for (let k = 0; k < GRASS.attempts && n < GRASS.maxBlades; k++) {
    const rng = mulberry32((baseSeed ^ Math.imul(k, 0x9e3779b1)) >>> 0);
    const x = (rng() - 0.5) * P.width;
    const z = (rng() - 0.5) * P.depth;
    if (sampleHeight(x, z) <= water.level + 0.05) continue;         // dry land only
    const fert = soilFertAt(x, z);
    if (fert < GRASS.minFert) continue;                             // bare / rocky
    if (rng() > sstep(GRASS.minFert, 1.0, fert)) continue;          // denser where fertile
    // A tuft of blades per accepted point, count scaling with fertility — this
    // is what makes rich ground read as lush instead of evenly stippled.
    const tuft = 1 + Math.round(fert * GRASS.tuftMax);
    for (let b = 0; b < tuft && n < GRASS.maxBlades; b++) {
      let bx = x, bz = z;
      if (b > 0) {
        const a = rng() * Math.PI * 2, rr = rng() * GRASS.tuftRadius;
        bx += Math.cos(a) * rr; bz += Math.sin(a) * rr;
      }
      const bh = sampleHeight(bx, bz);
      if (bh <= water.level + 0.05) continue;                       // a blade that fell into water
      const hMul = (GRASS.minScale + (1 - GRASS.minScale) * fert) * (0.8 + rng() * 0.4);
      const wMul = 0.85 + rng() * 0.3;
      _grassObj.position.set(bx, bh, bz);
      _grassObj.rotation.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.25);
      _grassObj.scale.set(wMul, hMul, wMul);
      _grassObj.updateMatrix();
      grassMesh.setMatrixAt(n, _grassObj.matrix);
      _grassCol.copy(_grassDry).lerp(_grassLush, fert).multiplyScalar(0.9 + rng() * 0.2);
      grassMesh.setColorAt(n, _grassCol);
      n++;
    }
  }
  grassMesh.count = n;
  grassMesh.instanceMatrix.needsUpdate = true;
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
}

/* Derive the soil carrying-capacity field for a freshly seeded world. Capacity
 * is anchored to the biomass the vegetation layer just placed in each patch
 * (so total plant density tracks the vegetation parameters), then modulated by
 * a world-seeded noise field into natural fertile/poor patches. Rich patches
 * get headroom to grow; the poorest sit below their initial planting and thin
 * into clearings. Call AFTER the plants are seeded (it reads their biomass). */
function generateSoilCapacity() {
  const tex = i => { soilTexData[i] = Math.round(Math.min(1, soilCap[i] / SOIL.maxCap) * 255); };
  if (!SOIL.genFertility) {
    soilCap.fill(SOIL.defaultCap);
    for (let i = 0; i < soilCap.length; i++) tex(i);
    soilTex.needsUpdate = true;
    return;
  }
  recomputeSoilLoad(); // per-patch biomass actually seeded
  const f = SOIL.genFreq, c = SOIL.genContrast, span = SOIL.fertMax - SOIL.fertMin;
  for (let pz = 0; pz < SPZ; pz++) {
    for (let px = 0; px < SPX; px++) {
      const i = pz * SPX + px;
      const wx = -P.width / 2 + (px + 0.5) * SOIL.patch;
      const wz = -P.depth / 2 + (pz + 0.5) * SOIL.patch;
      // Natural fertility field: world-seeded simplex, offset to decorrelate
      // from the terrain and the vegetation clump noise.
      const n = Math.pow(fbm(wx * f + 900, wz * f + 900) * 0.5 + 0.5, c);
      const mult = SOIL.fertMin + span * n;
      const cap = (SOIL.genFloor + soilLoad[i] * SOIL.genHeadroom) * mult;
      soilCap[i] = Math.max(0, Math.min(SOIL.maxCap, cap));
      tex(i);
    }
  }
  soilTex.needsUpdate = true;
}

function generateVegetation() {
  clearAllPlants();
  // Seed the natural layer UNGATED, then derive capacity from what landed —
  // capacity follows the vegetation params instead of pre-limiting them.
  soilCap.fill(Infinity);
  const G = CONFIG.vegGen;
  const shoreDist = computeShoreDist();
  for (let k = 0; k < G.attempts; k++) {
    const x = (Math.random() - 0.5) * P.width;
    const z = (Math.random() - 0.5) * P.depth;
    const dens = vegDensityAt(x, z, shoreDist);
    if (dens <= 0 || Math.random() > dens) continue;
    // Local spacing follows density: tight clusters on the coast, scattered
    // individuals inland. The 2.5x contrast boost lets high-density shore
    // points reach the dense end of the lerp (raw densities rarely exceed
    // ~0.4 after clump sharpening) — measured ~4:1 coast:interior packing.
    const spacing = VEG.spaceSparse + (VEG.spaceDense - VEG.spaceSparse) * Math.min(1, dens * 2.5);
    if (vegNear(x, z, spacing)) continue;
    addPlant(x, z, 2 + Math.random() * (VEG.maxFood - 2)); // varied maturity, not all sprouts
  }
  // Custom plant species (JSON): seed each into its own habitat. Spacing is
  // global (vegNear sees every plant), so species interleave without overlap.
  for (const id in PLANT_SPECIES) {
    const sp = PLANT_SPECIES[id];
    if (sp.id === 'plant') continue; // built-in already seeded above
    const attempts = Math.round(G.attempts * (sp.seedShare != null ? sp.seedShare : 0.6));
    for (let k = 0; k < attempts; k++) {
      const x = (Math.random() - 0.5) * P.width;
      const z = (Math.random() - 0.5) * P.depth;
      const dens = vegDensityAt(x, z, shoreDist, sp);
      if (dens <= 0 || Math.random() > dens) continue;
      if (!sp.canGerminate(x, z)) continue;
      const spacing = VEG.spaceSparse + (VEG.spaceDense - VEG.spaceSparse) * Math.min(1, dens * 2.5);
      if (vegNear(x, z, spacing)) continue;
      addPlant(x, z, 2 + Math.random() * (VEG.maxFood - 2), sp);
    }
  }
  generateSoilCapacity(); // capacity derived from the seeded biomass + fertility noise
  generateGrass();        // 3D grass layer follows the fertility field
  flushVegLayers();
  document.getElementById('r-plants').textContent = plants.length;
}

/* Nearest plant to (x, z) within maxR satisfying pred, via the spatial hash. */
function nearestPlant(x, z, maxR, pred) {
  const cx = Math.floor(x / vegCell), cz = Math.floor(z / vegCell);
  const ring = Math.ceil(maxR / vegCell);
  let best = null, bestD = maxR * maxR;
  for (let dc = -ring; dc <= ring; dc++) {
    for (let dr = -ring; dr <= ring; dr++) {
      const arr = vegGrid.get(vegKey(cx + dc, cz + dr));
      if (!arr) continue;
      for (const pl of arr) {
        if (pred && !pred(pl)) continue;
        const ex = pl.x - x, ez = pl.z - z, d = ex * ex + ez * ez;
        if (d < bestD) { bestD = d; best = pl; }
      }
    }
  }
  return best;
}

/* Nearest creature (live prey OR corpse) to (x, z) within maxR for which
 * `filter(agent)` holds. Linear scan over the given agent arrays — only
 * invoked when a hungry predator has no current target, so the cost is
 * occasional even at large populations. */
function nearestCreature(x, z, maxR, lists, filter) {
  let best = null, bestD = maxR * maxR;
  for (const list of lists) {
    for (const a of list) {
      if (!filter(a)) continue;
      const p = a.mesh.position;
      const ex = p.x - x, ez = p.z - z, d = ex * ex + ez * ez;
      if (d < bestD) { bestD = d; best = a; }
    }
  }
  return best;
}

/* Remove a creature entirely (eaten whole), as opposed to killCreature which
 * leaves a decaying corpse. Safe to call from a species tick that is NOT
 * iterating the victim's own array (fish/frog ticks eat insects from `birds`;
 * insect ticks scavenge corpses from `fishes`/`frogs`). */
function consumeAgent(a) {
  a.st.consumed = true;
  // Remove from the agent's real array (works for built-ins and JSON species).
  const reg = SPECIES[a.st.species];
  const list = reg ? reg.list
             : a.st.species === 'fish' ? fishes
             : a.st.species === 'frog' ? frogs : birds;
  const i = list.indexOf(a);
  if (i >= 0) list.splice(i, 1);
  platformGroup.remove(a.mesh);
  if (a.bar) barsGroup.remove(a.bar.group);
  updateCreatureReadout();
}

function sprayPlants(cx, cz) {
  const sel = document.getElementById('plant-select');
  const sp = (sel && PLANT_SPECIES[sel.value]) || PLANT_SPECIES.plant;
  const spacing = VEG.spaceSparse + (VEG.spaceDense - VEG.spaceSparse) * veg.density;
  let added = false;
  for (let k = 0; k < VEG.sprayAttempts; k++) {
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * veg.radius; // uniform over the disc
    const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
    if (Math.abs(x) > P.width / 2 || Math.abs(z) > P.depth / 2) continue;
    if (!sp.canGerminate(x, z)) continue;   // honor habitat: kelp only in water, etc.
    if (vegNear(x, z, spacing)) continue;
    if (addPlant(x, z, VEG.startFood, sp)) added = true;
  }
  if (added) {
    flushVegLayers();
    document.getElementById('r-plants').textContent = plants.length;
  }
}

/* ---- Seed dispersal -----------------------------------------------------
 * Each tick every plant has a small chance to fling a seed a short distance.
 * The throw is biased AWAY from the local cluster (computed from the spatial
 * hash) so colonies creep outward rather than just thickening. On landing:
 *   - empty land/waterline  -> a sprout germinates and slowly grows, OR
 *   - already occupied       -> the seed fails (the resident is unaffected).
 * The frontier expands into open ground; interior plants seed onto their own
 * neighbours and those seeds simply don't take. */
function outwardSeedDir(px, pz) {
  // Mean position of plants in the 3x3 neighbourhood; aim opposite the crowd.
  const cx = Math.floor(px / vegCell), cz = Math.floor(pz / vegCell);
  let sx = 0, sz = 0, n = 0;
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      const arr = vegGrid.get(vegKey(cx + dc, cz + dr));
      if (!arr) continue;
      for (const pl of arr) { sx += pl.x; sz += pl.z; n++; }
    }
  }
  if (n > 1) {
    const dx = px - sx / n, dz = pz - sz / n, len = Math.hypot(dx, dz);
    if (len > 1e-3) {
      const j = (Math.random() - 0.5) * 1.1; // angular jitter so it's not a laser
      const a = Math.atan2(dz, dx) + j;
      return [Math.cos(a), Math.sin(a)];
    }
  }
  const a = Math.random() * Math.PI * 2; // alone or symmetric: any direction
  return [Math.cos(a), Math.sin(a)];
}

/* Apply one seed landing at (x, z): a sprout of species `sp` takes where that
 * species may germinate, otherwise the seed fails (it does NOT disturb the
 * plant already there). */
function plantSeed(x, z, sp = PLANT_SPECIES.plant) {
  if (Math.abs(x) > P.width / 2 || Math.abs(z) > P.depth / 2) return; // off the platform
  if (nearestPlant(x, z, VEG.seedSpacing, null)) return; // occupied: the seed dies, resident lives
  if (!sp.canGerminate(x, z)) return;                    // wrong habitat: seed lost
  addPlant(x, z, VEG.startFood, sp);                     // suitable ground: sprout sticks & grows
}

/* Simulation half: food regrowth, rustle timers, and seed dispersal — runs
 * inside the sub-step loop, so at 100x sim speed it may run 20x per rendered
 * frame. It touches NUMBERS only (plus collecting seed landings to apply
 * after the loop); the GPU writes live in vegVisualTick, once per frame. */
function vegTick(dt) {
  // foodRegrow > 0 regrows toward maxFood; == 0 freezes food at its current
  // (finite) level; < 0 drains food, and a plant that reaches empty dies off.
  // sunlight only modulates growth, not the slider-driven die-off, so plants
  // wither at night-independent rate when growth is set negative.
  const delta = VEG.foodRegrow * (VEG.foodRegrow > 0 ? sunlight : 1) * dt;
  const seedP = VEG.seedRate * dt; // expected seed throws per plant this tick
  let seeds = null;                // collected, then applied after the loop
  // Iterate backward: removePlant() swap-fills the freed slot from the tail,
  // so a forward loop would skip the moved plant.
  const dieStep = SOIL.dieRate * dt;
  for (let i = plants.length - 1; i >= 0; i--) {
    const pl = plants[i];
    // Carrying-capacity die-back: a plant marked dying (by soilTick) sheds
    // biomass fast — it shrinks visibly, then is removed. It doesn't regrow or
    // seed while dying.
    if (pl.dying) {
      pl.food -= dieStep;
      if (pl.soil != null) soilLoad[pl.soil] = Math.max(0, soilLoad[pl.soil] - dieStep);
      if (pl.food <= 0) { removePlant(pl); continue; }
      pl.settle = true; // rewrite the (smaller) instance next frame
      continue;
    }
    if (delta > 0) {
      // Habitat gate: a water-only species regrows solely while submerged.
      if (pl.food < VEG.maxFood && pl.sp.canGrow(pl.x, pl.z)) pl.food = Math.min(VEG.maxFood, pl.food + delta);
    } else if (delta < 0) {
      pl.food += delta; // toward 0
      if (pl.food <= 0) { removePlant(pl); continue; } // withered away
    }
    if (pl.rustle > 0) {
      pl.rustle -= dt;
      pl.rustlePhase = (pl.rustlePhase || 0) + dt;
      if (pl.rustle <= 0) { pl.settle = true; pl.rustlePhase = 0; } // write rest pose next frame
    }
    // Seed throw: chance per tick, biased outward, landed nearby. Collected
    // now and applied below so we don't add/remove plants mid-iteration.
    if (Math.random() < seedP) {
      const [dx, dz] = outwardSeedDir(pl.x, pl.z);
      const r = VEG.seedDist * (0.5 + Math.random()); // 0.5x..1.5x mean distance
      (seeds || (seeds = [])).push(pl.x + dx * r, pl.z + dz * r, pl.sp);
    }
  }
  if (seeds) for (let k = 0; k < seeds.length; k += 3) plantSeed(seeds[k], seeds[k + 1], seeds[k + 2]);
}

/* Carrying-capacity enforcement (throttled — see soilAccum in animate). Resyncs
 * the per-patch biomass load (corrects incremental drift from growth/grazing),
 * then in any patch over its capacity rolls each plant against cullRate so
 * roughly 1-in-n start dying, easing the population back under the cap. */
function recomputeSoilLoad() {
  soilLoad.fill(0);
  for (const pl of plants) if (pl.soil != null) soilLoad[pl.soil] += pl.food;
}
function soilTick(dt) {
  recomputeSoilLoad();
  const p = SOIL.cullRate * (dt / SOIL.interval); // scale the per-pass chance to the real gap
  for (let i = plants.length - 1; i >= 0; i--) {
    const pl = plants[i];
    if (pl.dying) continue;
    if (soilLoad[pl.soil] > soilCap[pl.soil] && Math.random() < p) pl.dying = true;
  }
}

/* Visual half: rewrite an instance matrix only when its appearance actually
 * changed — rustling, just settled, or food drifted visibly since the last
 * write (writePlantInstance records pl.shownFood). Regrowth is slow, so this
 * cuts thousands of matrix composes per frame down to a handful. */
function vegVisualTick() {
  let dirtySet = null;
  for (let i = 0; i < plants.length; i++) {
    const pl = plants[i], L = pl.layer;
    let wrote = false;
    if (pl.rustle > 0)      { writePlantRustle(L, pl.idx, pl);  wrote = true; }
    else if (pl.settle)     { writePlantInstance(L, pl.idx, pl); pl.settle = false; wrote = true; }
    else if (Math.abs(pl.food - pl.shownFood) > 0.05) { writePlantInstance(L, pl.idx, pl); wrote = true; }
    if (wrote) (dirtySet || (dirtySet = new Set())).add(L);
  }
  if (dirtySet) for (const L of dirtySet) markVegLayer(L);
}

/* ============================================================
 * GRAZING  —  a hungry creature (reserve <= threshold) seeks the
 * nearest plant it can reach, stands by it to feed, then consumes
 * it and gains reserve. Returns the grazer's intent so each
 * species' movement can route to the plant or hold still to eat.
 *
 *  'none' — not hungry / nothing reachable: behave normally
 *  'move' — head toward st.grazeHeading
 *  'eat'  — stand still, feeding in progress
 * ============================================================ */
const GRAZE = CONFIG.grazing;
const PRED = CONFIG.predation;
const PREDATOR = CONFIG.predator;

/* ── Predator state machine ────────────────────────────────────────────────
 * A predator cycles through three behaviour states at random:
 *   resting   — sit still
 *   exploring — hop off in a random direction
 *   hunting   — path-seek the nearest prey (see seekNearestPrey) and close on it
 * It dwells in each state for a normally distributed span of game-seconds
 * (mean PREDATOR.meanStateTime), then switches to one of the OTHER two. State
 * lives on st.predState / st.predStateTimer and is lazily seeded on first tick,
 * so it covers built-in frogs and JSON terrestrial predators alike. */
const PRED_STATES = ['resting', 'exploring', 'hunting'];

// Standard normal via Box–Muller, scaled to (mean, std).
function gaussian(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const rollStateDuration = () =>
  Math.max(PREDATOR.minStateTime, gaussian(PREDATOR.meanStateTime, PREDATOR.stateTimeStd));
function nextPredatorState(cur) {
  let s; do { s = PRED_STATES[(Math.random() * PRED_STATES.length) | 0]; } while (s === cur);
  return s;
}
function predatorStateStep(st, dt) {
  if (st.predState == null) {                       // lazy seed: random start state
    st.predState = PRED_STATES[(Math.random() * PRED_STATES.length) | 0];
    st.predStateTimer = rollStateDuration();
  }
  st.predStateTimer -= dt;
  if (st.predStateTimer <= 0) {
    st.predState = nextPredatorState(st.predState);
    st.predStateTimer = rollStateDuration();
  }
}

/* Path seeking: the nearest live prey of this predator's diet within `radius`.
 * Returns { ref, heading, dist } (heading is the planar bearing to it), or null
 * when nothing edible is in range. Pure query — callers decide what to do. */
function seekNearestPrey(a, radius) {
  const diet = preyDietFor(a.st.species);
  if (!diet) return null;
  const p = a.mesh.position;
  const pr = nearestCreature(p.x, p.z, radius, diet.lists,
    c => !c.st.dead && !c.st.consumed && diet.reach(c.mesh.position)
         && (!diet.eats || diet.eats(c)));
  if (!pr) return null;
  const tp = pr.mesh.position;
  return { ref: pr, heading: Math.atan2(tp.z - p.z, tp.x - p.x),
           dist: Math.hypot(tp.x - p.x, tp.z - p.z) };
}

/* ── Per-species diet table ────────────────────────────────────────────────
 * Who hunts whom, keyed by PREDATOR species id. Hardcoded for now; the shape
 * (a plain record per predator) is deliberately extensible — add a row per new
 * predator today, or later populate it from the species JSON. `hunts` is the
 * set of PREY species ids this predator will pursue, layered as a species
 * filter on top of the array scan, so we stop treating "every flier in `birds`"
 * as edible and instead target named prey. `reach(pos)` is the positional
 * catchability test (e.g. prey must be over water the predator can reach). */
// Shared positional catchability tests (reach), by where the PREY sits:
const onLand     = pos => waterDepthAt(pos.x, pos.z) <= FROG.maxWade;   // land/shallows
const inWater    = pos => waterDepthAt(pos.x, pos.z) >= fishMinDepth;   // open water
// Waterline ambush band: all water PLUS the shore strip within 0.8 above the
// waterline. An aquatic ambush predator (caiman) can grab prey standing here —
// capybara never wade deep, so a deep-water-only reach (the old >=0.4) meant it
// could never count them; this catches prey at the bank.
const shoreOrWater = pos => waterDepthAt(pos.x, pos.z) >= -0.8;

const DIETS = {
  // ── L4 apex ──────────────────────────────────────────────────────────────
  jaguar:       { hunts: ['capybara', 'peccary', 'agouti', 'monkey', 'boa'], reach: onLand },
  harpy_eagle:  { hunts: ['monkey', 'sloth', 'macaw', 'boa'],                reach: onLand },
  black_caiman: { hunts: ['piranha', 'fish', 'capybara', 'frog', 'macaw'],   reach: shoreOrWater },
  // ── L3 mesopredators ─────────────────────────────────────────────────────
  boa:          { hunts: ['agouti', 'frog', 'anole', 'macaw'],               reach: onLand },
  ocelot:       { hunts: ['agouti', 'anole', 'frog', 'dart_frog', 'macaw'],  reach: onLand },
  monkey:       { hunts: ['beetle', 'ant'],                                  reach: onLand },
  piranha:      { hunts: ['fish', 'insect'],                                 reach: inWater },
  // ── L2 insectivores / small carnivores ───────────────────────────────────
  dart_frog:    { hunts: ['ant', 'beetle'],                                  reach: onLand },
  frog:         { hunts: ['beetle', 'butterfly', 'ant'],                     reach: onLand }, // tree frog
  anole:        { hunts: ['ant', 'beetle'],                                  reach: onLand },
  insect_bat:   { hunts: ['beetle', 'butterfly'] },                          // catches fliers anywhere
  macaw:        { hunts: ['insect'] },                                       // omnivore; also grazes

  // ══ Expanded Amazon food web ══════════════════════════════════════════════
  // ── Aquatic predators (reach = open water; ambush species grab the bank) ───
  arapaima:           { hunts: ['piranha', 'fish', 'koi', 'neon_tetra', 'pacu', 'tambaqui', 'discus_fish', 'plecostomus'], reach: inWater },
  giant_otter:        { hunts: ['piranha', 'fish', 'koi', 'neon_tetra', 'pacu', 'discus_fish'], reach: inWater },
  boto_dolphin:       { hunts: ['fish', 'koi', 'neon_tetra', 'piranha', 'tambaqui'], reach: inWater },
  arowana:            { hunts: ['fish', 'koi', 'neon_tetra', 'insect'],      reach: inWater },
  peacock_bass:       { hunts: ['fish', 'koi', 'neon_tetra'],                reach: inWater },
  wolf_fish:          { hunts: ['fish', 'koi', 'neon_tetra', 'frog'],        reach: shoreOrWater },
  electric_eel:       { hunts: ['fish', 'koi', 'neon_tetra'],                reach: inWater },
  redtail_catfish:    { hunts: ['fish', 'koi', 'neon_tetra', 'pacu'],        reach: inWater },
  freshwater_stingray:{ hunts: ['fish', 'neon_tetra'],                       reach: inWater },
  matamata_turtle:    { hunts: ['fish', 'neon_tetra'],                       reach: shoreOrWater },

  // ── Terrestrial mammal predators ───────────────────────────────────────────
  puma:           { hunts: ['capybara', 'peccary', 'white_lipped_peccary', 'agouti', 'paca', 'red_brocket_deer', 'gray_brocket_deer', 'monkey'], reach: onLand },
  jaguarundi:     { hunts: ['agouti', 'acouchi', 'paca', 'anole'],           reach: onLand },
  margay:         { hunts: ['agouti', 'acouchi', 'anole', 'capuchin'],       reach: onLand },
  oncilla:        { hunts: ['anole', 'dart_frog', 'ant', 'beetle', 'opossum'], reach: onLand },
  tayra:          { hunts: ['agouti', 'acouchi', 'paca', 'anole', 'capuchin'], reach: onLand },
  bush_dog:       { hunts: ['agouti', 'paca', 'acouchi', 'capybara'],        reach: onLand },
  crab_eating_fox:{ hunts: ['agouti', 'acouchi', 'frog', 'anole', 'beetle'], reach: onLand },
  giant_anteater: { hunts: ['ant', 'termite', 'beetle', 'army_ant', 'bullet_ant'], reach: onLand },
  tamandua:       { hunts: ['ant', 'termite', 'beetle'],                     reach: onLand },
  coati:          { hunts: ['beetle', 'rhinoceros_beetle', 'ant', 'anole', 'dart_frog'], reach: onLand },
  capuchin:       { hunts: ['beetle', 'ant', 'anole', 'frog'],               reach: onLand },

  // ── Reptile & amphibian predators ──────────────────────────────────────────
  green_anaconda:  { hunts: ['capybara', 'agouti', 'paca', 'white_lipped_peccary', 'red_brocket_deer', 'fish'], reach: shoreOrWater },
  emerald_tree_boa:{ hunts: ['anole', 'macaw', 'hummingbird', 'insect_bat'], reach: onLand },
  rainbow_boa:     { hunts: ['agouti', 'acouchi', 'anole', 'frog', 'opossum'], reach: onLand },
  fer_de_lance:    { hunts: ['agouti', 'acouchi', 'paca', 'frog', 'anole'],  reach: onLand },
  bushmaster:      { hunts: ['agouti', 'paca', 'acouchi', 'opossum'],        reach: onLand },
  coral_snake:     { hunts: ['anole', 'vine_snake', 'frog', 'dart_frog'],    reach: onLand },
  vine_snake:      { hunts: ['anole', 'frog', 'dart_frog', 'hummingbird'],   reach: onLand },
  tegu:            { hunts: ['insect', 'beetle', 'rhinoceros_beetle', 'frog', 'ant'], reach: onLand },
  caiman_lizard:   { hunts: ['frog', 'beetle', 'insect'],                    reach: shoreOrWater },
  green_basilisk:  { hunts: ['insect', 'ant', 'beetle', 'butterfly', 'firefly'], reach: onLand },
  horned_frog:     { hunts: ['insect', 'ant', 'beetle', 'frog', 'anole', 'dart_frog'], reach: onLand },
  cane_toad:       { hunts: ['ant', 'beetle', 'insect', 'termite'],          reach: onLand },

  // ── Bird raptors (strike terrestrial prey) ─────────────────────────────────
  ornate_hawk_eagle: { hunts: ['monkey', 'capuchin', 'howler_monkey', 'spider_monkey', 'macaw', 'agouti'], reach: onLand },
  great_black_hawk:  { hunts: ['anole', 'frog', 'agouti', 'coral_snake', 'acouchi'], reach: onLand },
  laughing_falcon:   { hunts: ['coral_snake', 'vine_snake', 'fer_de_lance', 'anole', 'rainbow_boa'], reach: onLand },
  crested_owl:       { hunts: ['agouti', 'paca', 'acouchi', 'insect_bat', 'opossum'], reach: onLand },
  spectacled_owl:    { hunts: ['agouti', 'opossum', 'acouchi', 'paca'],      reach: onLand },
  swallow_tailed_kite:{ hunts: ['insect', 'butterfly', 'blue_morpho', 'owl_butterfly', 'dragonfly', 'anole'], reach: onLand },
  // ── Bird waders / fishers (catch prey at the waterline) ────────────────────
  great_egret:       { hunts: ['fish', 'neon_tetra', 'frog', 'tambaqui'],    reach: shoreOrWater },
  cocoi_heron:       { hunts: ['fish', 'frog', 'neon_tetra', 'tambaqui'],    reach: shoreOrWater },
  jabiru_stork:      { hunts: ['fish', 'frog', 'neon_tetra', 'tambaqui', 'pacu'], reach: shoreOrWater },
  scarlet_ibis:      { hunts: ['insect', 'beetle', 'ant'],                   reach: shoreOrWater },
  anhinga:           { hunts: ['fish', 'neon_tetra', 'tambaqui'],            reach: shoreOrWater },
  ringed_kingfisher: { hunts: ['fish', 'neon_tetra'],                        reach: shoreOrWater },
  // ── Bird frugivore / insectivore omnivores ─────────────────────────────────
  toco_toucan:       { hunts: ['insect', 'butterfly', 'owl_butterfly'],      reach: onLand },
  green_aracari:     { hunts: ['insect', 'butterfly', 'blue_morpho'],        reach: onLand },
  hummingbird:       { hunts: ['insect'],                                    reach: onLand },
  paradise_tanager:  { hunts: ['insect', 'ant', 'termite'],                  reach: onLand },
  cock_of_the_rock:  { hunts: ['insect'],                                    reach: onLand },
  blue_and_gold_macaw:{ hunts: ['insect'] },
  hyacinth_macaw:    { hunts: ['insect'] },

  // ── Invertebrate predators ─────────────────────────────────────────────────
  praying_mantis:  { hunts: ['insect', 'butterfly', 'blue_morpho', 'owl_butterfly', 'firefly', 'ant'] },
  dragonfly:       { hunts: ['insect', 'butterfly', 'firefly', 'termite'] },
  tarantula:       { hunts: ['insect', 'beetle', 'rhinoceros_beetle', 'ant', 'frog', 'termite'], reach: onLand },
  wandering_spider:{ hunts: ['insect', 'beetle', 'ant', 'termite'],          reach: onLand },
  giant_centipede: { hunts: ['insect', 'beetle', 'ant', 'frog', 'anole', 'termite'], reach: onLand },
  scorpion:        { hunts: ['insect', 'beetle', 'ant', 'termite'],          reach: onLand },
  assassin_bug:    { hunts: ['insect', 'ant', 'termite', 'butterfly'] },
  army_ant:        { hunts: ['insect', 'beetle', 'termite', 'ant'],          reach: onLand },
  bullet_ant:      { hunts: ['insect', 'termite', 'ant'],                    reach: onLand },

  // ── Additional omnivores / insectivores / fishers ─────────────────────────
  squirrel_monkey:    { hunts: ['insect', 'ant', 'beetle'],                  reach: onLand },
  golden_lion_tamarin:{ hunts: ['insect', 'beetle'],                         reach: onLand },
  giant_armadillo:    { hunts: ['ant', 'termite', 'beetle', 'bullet_ant'],   reach: onLand },
  glass_frog:         { hunts: ['insect', 'ant', 'beetle'],                  reach: onLand },
  fruit_bat:          { hunts: ['insect'] },
  motmot:             { hunts: ['insect', 'beetle', 'butterfly'],            reach: onLand },
  woodpecker:         { hunts: ['insect', 'ant', 'beetle', 'termite'],       reach: onLand },
  hoatzin:            { hunts: ['insect'],                                   reach: onLand },
  payara:             { hunts: ['fish', 'koi', 'neon_tetra', 'pacu', 'piranha', 'silver_hatchetfish'], reach: inWater },
};

/* Build the `prey` sub-diet grazeControl expects from a predator's DIETS row.
 * Returns null when the species has no hunting behavior (it'll just graze). */
function preyDietFor(species) {
  const d = DIETS[species];
  if (!d || !d.hunts || !d.hunts.length) return null;
  const hunts = new Set(d.hunts);
  return {
    lists: [birds, frogs, fishes],           // candidate pool: every creature, any archetype...
    reach: d.reach || (() => true),          // ...filtered by where they can be caught...
    eats:  c => hunts.has(c.st.species),     // ...and by named prey species.
  };
}

/* Per-predator catch tuning, read LIVE from the predator's species cfg (e.g.
 * frog.json: contactRadius, winThreshold) so it's tunable per predator in the
 * config editor. Custom species ride their archetype's cfg; anything missing the
 * fields falls back to shared defaults. */
// Merged archetype cfg per custom aquatic/terrestrial species id (their own cfg
// over the FISH/FROG base), so per-species catch tuning isn't lost to the base.
// Populated by registerSpecies; aerial species keep theirs in FLIERS[id].cfg.
const ARCH_CFG = {};
function predCfg(species) {
  if (species === 'fish') return FISH;
  if (species === 'frog') return FROG;
  if (FLIERS[species]) return FLIERS[species].cfg;
  if (ARCH_CFG[species]) return ARCH_CFG[species];
  const list = SPECIES[species] && SPECIES[species].list;
  return list === fishes ? FISH : list === frogs ? FROG : null;
}
function huntParams(species) {
  const cfg = predCfg(species) || {};
  return {
    contactRadius: cfg.contactRadius != null ? cfg.contactRadius : PRED.eatRange,
    winThreshold:  cfg.winThreshold  != null ? cfg.winThreshold  : 0.5,
  };
}

/* Prey wins the coin-flip and bolts: an instant leap in a random direction that
 * clears the predator's contact radius by >2x (so the same approach can't
 * immediately re-roll). The prey's own tick reseats it onto terrain/water. */
function preyEscape(prey, contactRadius) {
  const p = prey.mesh.position;
  const ang = Math.random() * Math.PI * 2;
  const dist = contactRadius * 2 * (1.1 + Math.random() * 0.6); // strictly > 2x contact radius
  p.x = Math.max(-agentBoundX, Math.min(agentBoundX, p.x + Math.cos(ang) * dist));
  p.z = Math.max(-agentBoundZ, Math.min(agentBoundZ, p.z + Math.sin(ang) * dist));
}

/* Contact predation — the single, simple resolution for catching live prey,
 * kept separate from grazing so dense vegetation can't mask it. Each tick: if a
 * huntable prey (per the predator's DIETS row) sits within this predator's
 * contactRadius, roll once. r > winThreshold kills it and feeds the predator
 * (hunger capped); otherwise the prey escapes with a leap clear of the radius.
 * contactRadius + winThreshold are per-predator (species cfg, see huntParams).
 * Returns true on a kill. */
function predationContactStep(a) {
  const st = a.st;
  const diet = preyDietFor(st.species);
  if (!diet) return false;
  // Only strike when hungry enough — reserve at/below the forage threshold
  // (i.e. >50% hungry). A well-fed predator ignores prey it touches.
  if (!st.maxHunger || st.hunger > GRAZE.threshold * st.maxHunger) return false;
  const hp = huntParams(st.species);
  const p = a.mesh.position;
  const prey = nearestCreature(p.x, p.z, hp.contactRadius, diet.lists,
    c => !c.st.dead && !c.st.consumed && diet.reach(c.mesh.position)
         && (!diet.eats || diet.eats(c)));
  if (!prey) return false;
  if (Math.random() > hp.winThreshold) {           // win → kill + feed
    st.hunger = Math.min(st.maxHunger, (st.hunger || 0) + PRED.preyGain);
    feedGrowth(st, PRED.preyGain);
    consumeAgent(prey);
    return true;
  }
  preyEscape(prey, hp.contactRadius);              // loss → prey bolts away
  return false;
}

/* Unified forage controller. `diet` describes what this species GRAZES/scavenges:
 *   { plant: predicate,                         // grazeable plants (reach test)
 *     carrion: { lists } }                       // corpses it scavenges
 * (Live prey is handled separately by predationContactStep, above.)
 * Returns 'none' | 'move' | 'eat' and drives st.grazeHeading exactly as before,
 * so the species ticks need no changes. The current target is polymorphic
 * (st.forage = { type, ref }); it's re-acquired as the nearest edible thing of
 * ANY enabled kind whenever the held one becomes invalid. */
function forageValid(f) {
  if (!f) return false;
  if (f.type === 'plant')   return !f.ref.eaten;
  if (f.type === 'prey')    return !f.ref.st.dead && !f.ref.st.consumed;
  if (f.type === 'carrion') return f.ref.st.dead && !f.ref.st.consumed && f.ref.st.meat > 0;
  return false;
}
function foragePos(f) {
  return f.type === 'plant' ? f.ref : f.ref.mesh.position; // both expose .x/.z
}
/* Y coordinate of a forage target — plants sit on the terrain at their
 * visual radius; creatures have a real mesh Y. Used for 3D distance. */
function forageY(f) {
  if (f.type === 'plant') {
    const pl = f.ref;
    const foodFrac = pl.food / VEG.maxFood;
    const r = VEG.minRadius + (pl.maxR - VEG.minRadius) * foodFrac;
    return sampleHeight(pl.x, pl.z) + r;
  }
  return f.ref.mesh.position.y;
}

function grazeControl(a, dt, diet) {
  const st = a.st, p = a.mesh.position;
  if (!st.maxHunger) return 'none'; // hunger not initialized yet
  // Back-compat: a bare predicate means "plants only" (old call style).
  if (typeof diet === 'function') diet = { plant: diet };

  if (st.hunger > GRAZE.threshold * st.maxHunger) {
    st.forage = null; st.eatTimer = 0;
    return 'none';
  }

  if (!forageValid(st.forage)) {
    st.forage = null;
    st.forageRetry = (st.forageRetry || 0) - dt;
    // Always cheap to check plants (spatial hash); throttle the creature scans.
    let cand = null, candType = null, candD = Infinity;
    if (diet.plant) {
      const pl = nearestPlant(p.x, p.z, GRAZE.searchRadius, diet.plant);
      if (pl) {
        let d = (pl.x-p.x)**2 + (pl.z-p.z)**2;
        if (diet.use3D) { const plY = sampleHeight(pl.x, pl.z) + (VEG.minRadius + (pl.maxR - VEG.minRadius) * (pl.food / VEG.maxFood)); d += (plY - p.y) ** 2; }
        if (d < candD) { cand = pl; candType = 'plant'; candD = d; }
      }
    }
    if (diet.carrion && st.forageRetry <= 0) {
      const ca = nearestCreature(p.x, p.z, PRED.searchRadius, diet.carrion.lists,
        c => c.st.dead && !c.st.consumed && c.st.meat > 0);
      if (ca) {
        let d = (ca.mesh.position.x-p.x)**2 + (ca.mesh.position.z-p.z)**2;
        if (diet.use3D) d += (ca.mesh.position.y - p.y) ** 2;
        if (d < candD) { cand = ca; candType = 'carrion'; candD = d; }
      }
      if (!cand) st.forageRetry = PRED.retryDelay; // nothing found: back off the scan
    }
    if (cand) { st.forage = { type: candType, ref: cand }; st.eatTimer = 0; }
  }

  const f = st.forage;
  if (!f) return 'none'; // nothing reachable in range — wander (may starve)
  const tp = foragePos(f);
  const range = f.type === 'plant' ? GRAZE.eatRange : PRED.eatRange;
  const dist = diet.use3D
    ? Math.sqrt((tp.x-p.x)**2 + (forageY(f)-p.y)**2 + (tp.z-p.z)**2)
    : Math.hypot(tp.x - p.x, tp.z - p.z);
  st.grazeHeading = Math.atan2(tp.z - p.z, tp.x - p.x);

  if (dist <= range) {
    st.eatTimer += dt;
    if (f.type === 'plant') {
      f.ref.rustle = RUSTLE.hold; // keep the bush shaking while it's fed on
      if (st.eatTimer >= GRAZE.eatDuration) {
        f.ref.food -= 1;
        st.hunger = Math.min(st.maxHunger, st.hunger + GRAZE.gain);
        feedGrowth(st, GRAZE.gain);
        if (f.ref.food <= 0) removePlant(f.ref);
        else { writePlantInstance(f.ref.layer, f.ref.idx, f.ref); markVegLayer(f.ref.layer); }
        st.forage = null; st.eatTimer = 0;
      }
    } else { // carrion: bite, draining the corpse's meat; remove when stripped
      if (st.eatTimer >= PRED.biteDuration) {
        const bite = Math.min(PRED.biteGain, f.ref.st.meat);
        f.ref.st.meat -= bite;
        st.hunger = Math.min(st.maxHunger, st.hunger + bite);
        feedGrowth(st, bite);
        if (f.ref.st.meat <= 0) consumeAgent(f.ref); // fully scavenged
        st.forage = null; st.eatTimer = 0;
      }
    }
    return 'eat';
  }
  st.eatTimer = 0;
  return 'move';
}

/* Feeding animation knobs. The bob is a rhythmic downward nibble; the rustle
 * shakes the eaten bush (a scale-pulse + sway, since spheres ignore rotation). */
const EAT = { bobRate: 9, bobFrac: 0.22 };
const RUSTLE = { hold: 0.12, rate: 22, scaleAmp: 0.10, squash: 0.06, swayFrac: 0.08 };
function eatBob(st, h) {
  return -Math.abs(Math.sin(st.eatTimer * EAT.bobRate)) * h * EAT.bobFrac; // downward pecks
}

// Reachability predicates: which plants a given locomotion type can feed at.
const plantInWater    = pl => waterDepthAt(pl.x, pl.z) >= fishMinDepth;
const plantOnFrogLand = pl => waterDepthAt(pl.x, pl.z) <= FROG.maxWade;


/* ============================================================
 * FROG  —  land population: squat green hitboxes that hop.
 *
 *  land:    hops between idle pauses; every hop's landing zone
 *           is validated so it won't leap into water deeper
 *           than it can wade.
 *  swamped: dunked in deep water (raised level / missed hop) —
 *           floats to the surface and paddles toward the
 *           shallowest direction until it can stand.
 * ============================================================ */
const FROG = requireDef('frog').cfg;
const frogGeo = new THREE.BoxGeometry(FROG.length, FROG.height, FROG.width);
const frogMat = new THREE.MeshStandardMaterial({
  color: 0x2ecc40,            // bright primary green
  emissive: 0x0a4412,
  emissiveIntensity: 0.4,
  roughness: 0.6,
});

function frogValidLanding(x, z) {
  if (Math.abs(x) > agentBoundX || Math.abs(z) > agentBoundZ) return false;
  return waterDepthAt(x, z) <= FROG.maxWade;
}

function spawnFrog(x, z, opts = {}) {
  if (agentCount() >= AGENT_CAP) return;
  const { mesh, st } = createAgent('frog', BREEDING.frog, frogGeo, frogMat, {
    mode: 'land',          // 'land' | 'swamped'
    vel: new THREE.Vector3(),
    hopTimer: 0.6 + Math.random(),
    paddleTimer: 0,
    grounded: false,
  }, !!opts.newborn);
  // Drop in from above; if it splashes into deep water the land tick's
  // dunk check hands it straight to the swamped state.
  dropFromAbove(mesh, x, z, FROG.height / 2);
  frogs.push({ mesh, st });
  updateCreatureReadout();
}

/* Random spawn onto dry land (centre drop if the island is submerged). */
function spawnFrogRandom() {
  for (let i = 0; i < 600; i++) {
    const x = (Math.random() - 0.5) * (P.width - 5);
    const z = (Math.random() - 0.5) * (P.depth - 5);
    if (sampleHeight(x, z) >= water.level + 0.2) { spawnFrog(x, z); return; }
  }
  spawnFrog(0, 0);
}

/* One hop: wander-drift the heading, but reject hops whose landing
 * zone is deep water or out of bounds. */
function frogHop(a, jitter = 1.4) {
  const p = a.mesh.position, st = a.st;
  let h = st.heading + (Math.random() - 0.5) * jitter;
  const landingOk = (ang) => frogValidLanding(p.x + Math.cos(ang) * 3, p.z + Math.sin(ang) * 3);
  if (!landingOk(h)) {
    const offsets = [0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.6, -2.6, Math.PI];
    let turned = false;
    for (const o of offsets) {
      if (landingOk(h + o)) { h += o; turned = true; break; }
    }
    if (!turned) h += Math.PI; // surrounded: hop back the way it came
  }
  st.heading = h;
  const horiz = FROG.hopHoriz * (0.7 + Math.random() * 0.6);
  st.vel.set(
    Math.cos(h) * horiz,
    FROG.hopVert * (0.85 + Math.random() * 0.3),
    Math.sin(h) * horiz
  );
  st.hopTimer = FROG.hopWaitMin + Math.random() * (FROG.hopWaitMax - FROG.hopWaitMin);
}

function frogLandTick(a, dt) {
  const p = a.mesh.position, st = a.st, v = st.vel;

  // Ballistic integration with gravity.
  v.y -= FROG.gravity * dt;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;

  // Fence containment.
  if (Math.abs(p.x) > agentBoundX) { p.x = Math.sign(p.x) * agentBoundX; v.x = 0; }
  if (Math.abs(p.z) > agentBoundZ) { p.z = Math.sign(p.z) * agentBoundZ; v.z = 0; }

  // Land contact against the heightfield.
  const groundY = sampleHeight(p.x, p.z) + FROG.height / 2 + 0.02;
  if (p.y <= groundY) {
    p.y = groundY;
    if (v.y < 0) v.y = 0;
    const fr = Math.max(0, 1 - dt * 8);
    v.x *= fr; v.z *= fr;
    st.grounded = true;
  } else {
    st.grounded = false;
  }

  // Dunked in deep water (body at/under the surface) -> swim for it.
  if (waterDepthAt(p.x, p.z) > FROG.maxWade && p.y - FROG.height / 2 <= water.level) {
    st.mode = 'swamped';
    st.paddleTimer = 0;
    v.set(0, 0, 0);
    return;
  }

  // Grazing & hunger: frogs eat land vegetation through the shared forager (this
  // owns plant eat-on-contact and the energy economy). Catching live prey is
  // handled separately by predationContactStep — a contact coin-flip that doesn't
  // compete with grazing — so dense plants can't crowd the beetle out of the scan.
  const graze = grazeControl(a, dt, { plant: plantOnFrogLand });
  predationContactStep(a); // see DIETS — the frog hunts beetles

  // Predator state machine: resting | exploring | hunting (switches at random,
  // dwelling ~PREDATOR.meanStateTime game-seconds, normally distributed).
  predatorStateStep(st, dt);

  // Path seeking (every tick): find the nearest prey within huntRadius and point
  // at it. Resting/hunting frogs face the prey; only a hunting frog advances on it.
  const prey = seekNearestPrey(a, PREDATOR.huntRadius);
  if (prey && st.predState !== 'exploring') st.heading = prey.heading;

  // Grounded: idle, then hop (unless standing to feed). The state picks the hop.
  if (st.grounded && graze !== 'eat') {
    st.hopTimer -= dt;
    if (st.hopTimer <= 0) {
      if (st.predState === 'hunting') {
        if (prey) { st.heading = prey.heading; frogHop(a, 0.3); } // close on the prey
        else frogHop(a);                                          // none seen: prowl
      } else if (st.predState === 'exploring') {
        frogHop(a);                                               // wander at random
      } else {
        st.hopTimer = FROG.hopWaitMin;                            // resting: sit still
      }
    }
  }
  if (graze === 'eat' && st.grounded) {
    p.y = sampleHeight(p.x, p.z) + FROG.height / 2 + 0.02 + eatBob(st, FROG.height); // nibble bob
  }

  const normal = st.grounded ? terrainNormalAt(p.x, p.z) : UP;
  orientAgent(a.mesh, st.heading, normal, 0, dt);
}

function frogSwampedTick(a, dt) {
  const p = a.mesh.position, st = a.st;

  // Buoyancy: float up to ride mostly at the surface.
  const targetY = water.level - FROG.height * 0.25;
  p.y += (targetY - p.y) * Math.min(1, dt * 5);

  // Steer for shore (shared two-range probe with heading persistence).
  steerTowardShallows(p, st, dt);

  // Paddle.
  p.x += Math.cos(st.heading) * FROG.paddleSpeed * dt;
  p.z += Math.sin(st.heading) * FROG.paddleSpeed * dt;
  p.x = Math.max(-agentBoundX, Math.min(agentBoundX, p.x));
  p.z = Math.max(-agentBoundZ, Math.min(agentBoundZ, p.z));

  // Feet can touch bottom again -> back on land.
  if (waterDepthAt(p.x, p.z) <= FROG.maxWade) {
    st.mode = 'land';
    st.vel.set(0, 0, 0);
    st.hopTimer = 0.5;
    return;
  }

  orientAgent(a.mesh, st.heading, UP, 0, dt);
}

function frogTick(dt) {
  const br = BREEDING.frog;
  for (const a of frogs) {
    if (a.st.dead) continue;
    if (a.st.aiSuspended) continue;
    maturationStep(a, br, dt);
    (a.st.mode === 'land' ? frogLandTick : frogSwampedTick)(a, dt);
    layStep(a, br, dt, a.st.mode === 'land' && a.st.grounded); // lay on land, standing
  }
}

/* ============================================================
 * FLIERS  —  the flighted species (currently just the insect),
 * sharing one set of mechanics (walk / wandering flight / swim
 * on water, slower than fish). FLIER_BASE (from insect.json) is the
 * shared flier base config that each flier derives from.
 *
 *  insect:  black 1 x 1 x 1 cube, comfortable low to the deck
 * ============================================================ */
// The aerial archetype base now comes from insect.json (the canonical flier);
// every flier — including the built-in insect — merges its own cfg over it.
const FLIER_BASE = requireDef('insect').cfg;
function makeFlierSpecies(overrides, matOpts) {
  const cfg = Object.assign({}, FLIER_BASE, overrides);
  return {
    cfg,
    geo: new THREE.BoxGeometry(cfg.length, cfg.height, cfg.width),
    mat: new THREE.MeshStandardMaterial(matOpts),
  };
}
const FLIERS = {
  insect: makeFlierSpecies(
    {},                                   // insect IS the aerial base (cfg from insect.json)
    { color: 0x111111, roughness: 0.7 }   // matte black cube
  ),
};

/* ============================================================
 * JSON-DEFINED SPECIES
 *
 * Every species — the built-in fish/frog/insect/plant AND the custom
 * ones — is declared in config/species/*.json (listed in manifest.json).
 * Each picks a behavior archetype (aquatic | terrestrial | aerial |
 * plant) and rides that archetype's physics, diet, and breeding,
 * supplying its own name, color (optionally genetic), 3D model, chart
 * color, egg style, and any cfg/breeding overrides. The built-in trio
 * keep their dedicated spawn paths + visuals and are skipped here (they
 * already hold SPECIES entries); this registers the rest.
 * ============================================================ */
// Per-species model assets, looked up by id when (re)building visuals.
const RENDER_KIT = {
  fish:   { geo: fishGeo, mat: fishMat },
  frog:   { geo: frogGeo, mat: frogMat },
  insect: { geo: FLIERS.insect.geo, mat: FLIERS.insect.mat },
};

// Aquatic newcomer: mirrors spawnFish exactly, but with the species' own id,
// material, model, and (optional) genetic color.
function spawnArchetypeAquatic(def, x, z, opts = {}) {
  if (agentCount() >= AGENT_CAP) return;
  const kit = RENDER_KIT[def.id];
  const color = def.geneticColor ? (opts.color ? new THREE.Color(opts.color) : randomFishColor()) : null;
  const tint = color || new THREE.Color(def.color != null ? def.color : 0x888888);
  const { mesh, st } = createAgent(def.id, BREED_F, kit.geo, kit.mat, {
    mode: 'swim', vel: new THREE.Vector3(), flopTimer: 0.4, grounded: false, seekTime: 0,
    ...(color ? { color } : {}),
  }, !!opts.newborn, tint);
  if (fishNavigable(x, z)) {
    mesh.position.set(x, Math.max(sampleHeight(x, z) + FISH.height / 2 + 0.1, water.level - FISH.surfaceMargin - Math.random() * Math.max(0, water.level - sampleHeight(x, z) - FISH.height - FISH.surfaceMargin)), z);
  } else {
    st.mode = 'beached';
    mesh.position.set(x, sampleHeight(x, z) + FISH.height / 2 + 1.5, z);
  }
  fishes.push({ mesh, st });
  updateCreatureReadout();
}

// Terrestrial newcomer: mirrors spawnFrog.
function spawnArchetypeTerrestrial(def, x, z, opts = {}) {
  if (agentCount() >= AGENT_CAP) return;
  const kit = RENDER_KIT[def.id];
  const color = def.geneticColor ? (opts.color ? new THREE.Color(opts.color) : randomFishColor()) : null;
  const tint = color || new THREE.Color(def.color != null ? def.color : 0x6a8f4a);
  const { mesh, st } = createAgent(def.id, BREEDING.frog, kit.geo, kit.mat, {
    mode: 'land', vel: new THREE.Vector3(), hopTimer: 0.6 + Math.random(), paddleTimer: 0, grounded: false,
    ...(color ? { color } : {}),
  }, !!opts.newborn, tint);
  dropFromAbove(mesh, x, z, FROG.height / 2);
  frogs.push({ mesh, st });
  updateCreatureReadout();
}

/* Register all species from the already-loaded RAW_SPECIES (the fetch ran up top
 * in loadSpeciesData, before engine init). Built-in fish/frog/insect are skipped
 * here — they already have SPECIES entries and dedicated spawn/visuals; this
 * wires up the custom creatures and every plant, including the default "plant". */
function registerSpecies() {
  const defs = RAW_SPECIES.map(e => e.def);
  const select = document.getElementById('creature-select');

  for (const d of defs) {
    if (!d || !d.id || SPECIES[d.id] || PLANT_SPECIES[d.id]) continue; // skip malformed / collisions / built-ins

    // ---- Plants ----------------------------------------------------------
    if (d.behavior === 'plant') {
      const water_ = d.habitat === 'water';
      // Colors: explicit young/old gradient, or derive a light->dark ramp from a
      // single base color.
      let young, old;
      if (d.colorYoung != null || d.colorOld != null) {
        young = new THREE.Color(d.colorYoung != null ? d.colorYoung : d.colorOld);
        old   = new THREE.Color(d.colorOld   != null ? d.colorOld   : d.colorYoung);
      } else {
        const base = new THREE.Color(d.color != null ? d.color : 0x4caf50);
        young = base.clone().lerp(new THREE.Color(0xffffff), 0.45);
        old   = base.clone().multiplyScalar(0.55);
      }
      const minDepth = d.minDepth != null ? d.minDepth : 0.5; // water species: how submerged to count
      registerPlantSpecies({
        id: d.id, label: d.name || d.id, chartColor: d.chartColor || '#' + old.getHexString(),
        young, old, maxR: d.maxRadius != null ? d.maxRadius : VEG.maxRadius,
        habitat: water_ ? 'water' : 'land',
        seedShare: d.seedShare,
        canGerminate: water_ ? (x, z) => waterDepthAt(x, z) >= minDepth
                             : (x, z) => waterDepthAt(x, z) <= VEG.seedMaxDepth,
        canGrow:      water_ ? (x, z) => waterDepthAt(x, z) >= minDepth
                             : () => true,
      });
      continue;
    }

    if (SPECIES[d.id]) continue;                                 // (creature id already taken)
    const arch = d.behavior;
    if (!['aquatic', 'terrestrial', 'aerial'].includes(arch)) {
      console.warn(`species "${d.id}": unknown behavior "${arch}" — skipped`); continue;
    }
    const archBuiltin = arch === 'aquatic' ? 'fish' : arch === 'terrestrial' ? 'frog' : 'insect';

    // Detailed model builder: declarative parts, a named built-in, else the
    // archetype's built-in shape recolored.
    DETAILED_BUILDERS[d.id] = (d.model && d.model.parts)
      ? (t) => buildPartsModel(d.model.parts, d.color, d.geneticColor ? t : undefined, d.pov)
      : (d.model && d.model.builtin && DETAILED_BUILDERS[d.model.builtin])
        ? (t) => DETAILED_BUILDERS[d.model.builtin](d.geneticColor ? t : new THREE.Color(d.color != null ? d.color : 0xffffff))
        : (t) => DETAILED_BUILDERS[archBuiltin](d.geneticColor ? t : new THREE.Color(d.color != null ? d.color : 0xffffff));
    // Real-world size: scale the detailed model by the species' sizeScale.
    // Ground animals (terrestrial) grow upward from their feet so seating is
    // preserved; free swimmers/fliers scale about their centre.
    if (d.sizeScale != null && d.sizeScale !== 1) {
      DETAILED_BUILDERS[d.id] = scaleBuilder(DETAILED_BUILDERS[d.id], d.sizeScale, arch === 'terrestrial');
    }

    EGG_STYLE[d.id] = d.egg || EGG_STYLE[archBuiltin];           // own egg or the archetype's
    POP_SERIES.push({ key: d.id, label: d.name || d.id, color: d.chartColor || d.color || '#cccccc' });
    if (select) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name || d.id; select.appendChild(o);
    }

    if (arch === 'aerial') {
      const fl = makeFlierSpecies(Object.assign({}, d.cfg), { color: new THREE.Color(d.color != null ? d.color : 0x111111), roughness: 0.7 });
      FLIERS[d.id] = fl;
      RENDER_KIT[d.id] = { geo: fl.geo, mat: fl.mat };
      BREEDING[d.id] = Object.assign({}, BREEDING.insect, d.breeding);
      SPECIES[d.id] = { list: birds, spawn: (x, z, o) => spawnBird(d.id, x, z, o), br: BREEDING[d.id] };
    } else {
      const isAq = arch === 'aquatic';
      ARCH_CFG[d.id] = Object.assign({}, isAq ? FISH : FROG, d.cfg); // own cfg over the base, for predCfg/huntParams
      RENDER_KIT[d.id] = {
        geo: isAq ? fishGeo : frogGeo,                            // shares the archetype's hitbox
        mat: new THREE.MeshStandardMaterial({ color: new THREE.Color(d.color != null ? d.color : 0x888888), roughness: 0.6, metalness: 0 }),
      };
      BREEDING[d.id] = isAq ? BREED_F : BREEDING.frog;            // rides the archetype's breeding
      SPECIES[d.id] = {
        list: isAq ? fishes : frogs,
        spawn: isAq ? ((x, z, o) => spawnArchetypeAquatic(d, x, z, o)) : ((x, z, o) => spawnArchetypeTerrestrial(d, x, z, o)),
        br: BREEDING[d.id],
      };
    }
  }
}

function birdWalkable(sp, x, z) {
  if (Math.abs(x) > agentBoundX || Math.abs(z) > agentBoundZ) return false;
  return waterDepthAt(x, z) <= sp.maxWade;
}

const walkFlightWait = (sp) => sp.walkFlightMin + Math.random() * (sp.walkFlightMax - sp.walkFlightMin);
const swimFlightWait = (sp) => sp.swimFlightMin + Math.random() * (sp.swimFlightMax - sp.swimFlightMin);

function spawnBird(type, x, z, opts = {}) {
  const species = FLIERS[type];
  if (!species || agentCount() >= AGENT_CAP) return;
  const sp = species.cfg;
  const { mesh, st } = createAgent(type, BREEDING[type], species.geo, species.mat, {
    mode: 'walk',          // 'walk' | 'fly' | 'swim'
    flightTimer: walkFlightWait(sp),
    paddleTimer: 0,
    // flight dynamics (set on takeoff)
    flightDur: 0, turnRate: 0, loopT: 0, altTarget: 0, descending: false,
  }, !!opts.newborn);
  // Drop in from above; the walk tick resolves water spawns to swim.
  dropFromAbove(mesh, x, z, sp.height / 2);
  birds.push({ mesh, st, sp });
  updateCreatureReadout();
}

/* Random spawn onto dry land (centre drop if the island is submerged). */
function spawnBirdRandom(type = 'insect') {
  for (let i = 0; i < 600; i++) {
    const x = (Math.random() - 0.5) * (P.width - 5);
    const z = (Math.random() - 0.5) * (P.depth - 5);
    if (sampleHeight(x, z) >= water.level + 0.2) { spawnBird(type, x, z); return; }
  }
  spawnBird(type, 0, 0);
}

/* Shortest signed angle from b to a. */
const angDiff = (a, b) => ((a - b + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

/* Lift off into a wandering flight of random duration. */
function birdTakeOff(a) {
  const st = a.st, sp = a.sp;
  st.mode = 'fly';
  st.flightDur = sp.flightDurMin + Math.random() * (sp.flightDurMax - sp.flightDurMin);
  st.turnRate = 0;
  st.loopT = 0;
  st.altTarget = sp.altMin + Math.random() * (sp.altMax - sp.altMin);
  st.descending = false;
}

function birdWalkTick(a, dt) {
  const p = a.mesh.position, st = a.st, sp = a.sp;
  predationContactStep(a); // aerial predators (eagle, bat, macaw) catch live prey via DIETS

  // Water rose over its feet -> it just swims.
  if (waterDepthAt(p.x, p.z) > sp.maxWade) {
    st.mode = 'swim';
    st.paddleTimer = 0;
    st.flightTimer = swimFlightWait(sp);
    return;
  }

  // Fliers (insects, beetles, ...) are scavengers: they feed only on dead fish
  // and frogs (carrion), wandering/flying between corpses, not on vegetation.
  const graze = grazeControl(a, dt, {
    carrion: { lists: [fishes, frogs] },
  });

  // Momentary flights — suppressed while it's busy grazing.
  if (graze === 'none') {
    st.flightTimer -= dt;
    if (st.flightTimer <= 0) { birdTakeOff(a); return; }
  }

  if (graze === 'eat') {
    // Stand by the plant, seated on the terrain, bobbing to peck.
    st.heading += angDiff(st.grazeHeading, st.heading) * Math.min(1, dt * 3);
    const gy = sampleHeight(p.x, p.z) + sp.height / 2 + 0.02;
    p.y = gy + eatBob(st, sp.height);
    orientAgent(a.mesh, st.heading, terrainNormalAt(p.x, p.z), 0, dt);
    return;
  }

  // Steer toward the plant, or wander.
  if (graze === 'move') {
    st.heading += angDiff(st.grazeHeading, st.heading) * Math.min(1, dt * 3);
  } else {
    st.heading += (Math.random() - 0.5) * sp.turnNoise * dt;
  }

  const probeBlocked = (ang) => !birdWalkable(sp,
    p.x + Math.cos(ang) * sp.lookAhead,
    p.z + Math.sin(ang) * sp.lookAhead
  );
  if (probeBlocked(st.heading)) {
    const offsets = [0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.6, -2.6, Math.PI];
    let turned = false;
    for (const o of offsets) {
      if (!probeBlocked(st.heading + o)) { st.heading += o; turned = true; break; }
    }
    if (!turned) st.heading += Math.PI;
  }
  const nx = p.x + Math.cos(st.heading) * sp.walkSpeed * dt;
  const nz = p.z + Math.sin(st.heading) * sp.walkSpeed * dt;
  if (birdWalkable(sp, nx, nz)) { p.x = nx; p.z = nz; }

  // Glued to the terrain, seated to the slope.
  const groundY = sampleHeight(p.x, p.z) + sp.height / 2 + 0.02;
  p.y += (groundY - p.y) * Math.min(1, dt * 8);
  orientAgent(a.mesh, st.heading, terrainNormalAt(p.x, p.z), 0, dt);
}

function birdFlyTick(a, dt) {
  const p = a.mesh.position, st = a.st, sp = a.sp;
  predationContactStep(a); // a flier stoops on prey it passes over (eagle, bat) — DIETS
  st.flightDur -= dt;
  if (st.flightDur <= 0) st.descending = true;

  if (st.loopT > 0) {
    // Committed loop: hold the turn rate until the circle closes.
    st.loopT -= dt;
  } else if (!st.descending) {
    // Drifting turn rate -> lazy arcs and S-curves, not straight legs.
    st.turnRate += (Math.random() - 0.5) * 4 * dt;
    st.turnRate *= 1 - dt * 0.8; // relax back toward straight
    st.turnRate = Math.max(-sp.maxTurn, Math.min(sp.maxTurn, st.turnRate));

    // Occasionally commit to a full loop.
    if (Math.random() < dt * sp.loopChance) {
      const rate = (Math.random() < 0.5 ? -1 : 1) * (1.8 + Math.random() * 0.7);
      st.turnRate = rate;
      st.loopT = (Math.PI * 2) / Math.abs(rate); // exactly one circle
    }

    // Altitude target random-walks across the whole band.
    st.altTarget += (Math.random() - 0.5) * sp.altDrift * dt;
    st.altTarget = Math.max(sp.altMin, Math.min(sp.altMax, st.altTarget));
  }

  // Boundary steering: bend back toward the centre when the fence nears
  // (overrides any loop in progress).
  const aheadX = p.x + Math.cos(st.heading) * 14;
  const aheadZ = p.z + Math.sin(st.heading) * 14;
  if (Math.abs(aheadX) > agentBoundX || Math.abs(aheadZ) > agentBoundZ) {
    st.loopT = 0;
    const toCentre = Math.atan2(-p.z, -p.x);
    st.heading += angDiff(toCentre, st.heading) * Math.min(1, dt * 2.5);
  }

  // Advance along the heading.
  st.heading += st.turnRate * dt;
  p.x += Math.cos(st.heading) * sp.flySpeed * dt;
  p.z += Math.sin(st.heading) * sp.flySpeed * dt;
  p.x = Math.max(-agentBoundX, Math.min(agentBoundX, p.x));
  p.z = Math.max(-agentBoundZ, Math.min(agentBoundZ, p.z));

  // Altitude: chase the wandering target above the local surface
  // (or the surface itself when descending), never clipping a ridge —
  // clearance scales with the species' body height.
  const surfHere = Math.max(sampleHeight(p.x, p.z), water.level);
  const yT = surfHere + (st.descending ? sp.height / 2 + 0.1 : st.altTarget);
  p.y += (yT - p.y) * Math.min(1, dt * (st.descending ? 2.2 : 1.8));
  p.y = Math.max(p.y, surfHere + sp.height / 2 + 0.3);

  // Touch down: water -> swim, land -> walk.
  if (st.descending && p.y - surfHere < sp.height / 2 + 0.5) {
    if (waterDepthAt(p.x, p.z) > sp.maxWade) {
      st.mode = 'swim';
      st.paddleTimer = 0;
      st.flightTimer = swimFlightWait(sp);
    } else {
      st.mode = 'walk';
      st.flightTimer = walkFlightWait(sp);
    }
    return;
  }

  // Bank into the turn (roll about the long axis).
  const bank = Math.max(-0.9, Math.min(0.9, -st.turnRate * 0.45));
  orientAgent(a.mesh, st.heading, UP, bank, dt);
}

function birdSwimTick(a, dt) {
  const p = a.mesh.position, st = a.st, sp = a.sp;
  predationContactStep(a); // can still snatch prey while paddling — DIETS

  // Float at the surface, but never sink the hull into a shallow lakebed.
  const targetY = Math.max(
    water.level - sp.height * 0.3,
    sampleHeight(p.x, p.z) + sp.height * 0.25
  );
  p.y += (targetY - p.y) * Math.min(1, dt * 5);

  // Birds don't linger on water — take off sooner than from land.
  st.flightTimer -= dt;
  if (st.flightTimer <= 0) { birdTakeOff(a); return; }

  // Paddle for shore (shared steering), slower than any fish.
  steerTowardShallows(p, st, dt);
  p.x += Math.cos(st.heading) * sp.swimSpeed * dt;
  p.z += Math.sin(st.heading) * sp.swimSpeed * dt;
  p.x = Math.max(-agentBoundX, Math.min(agentBoundX, p.x));
  p.z = Math.max(-agentBoundZ, Math.min(agentBoundZ, p.z));

  // Feet on the bottom -> resume walking.
  if (waterDepthAt(p.x, p.z) <= sp.maxWade) {
    st.mode = 'walk';
    st.flightTimer = walkFlightWait(sp);
    return;
  }

  orientAgent(a.mesh, st.heading, UP, 0, dt);
}

function birdTick(dt) {
  for (const a of birds) {
    if (a.st.dead) continue;
    if (a.st.aiSuspended) continue;
    const br = BREEDING[a.st.species];
    maturationStep(a, br, dt);
    if (a.st.mode === 'walk') birdWalkTick(a, dt);
    else if (a.st.mode === 'fly') birdFlyTick(a, dt);
    else birdSwimTick(a, dt);
    layStep(a, br, dt, a.st.mode === 'walk'); // lay while walking on land
  }
}

/* ============================================================
 * HUNGER  —  every creature carries a hunger value in [0, max].
 * Adults cap at 100, immature creatures at 25. Hunger rises over
 * time (eating, once grazing exists, will lower it). A billboarded
 * bar floats above each creature: its width scales with capacity
 * (so a baby's bar is visibly shorter) and its fill goes green
 * (sated) to red (starving).
 *
 * Hunger and the bar are initialized lazily on first sight, so no
 * per-species spawn code needs to know about hunger.
 * ============================================================ */
const HUNGER = CONFIG.hunger;
const barsGroup = new THREE.Group();
barsGroup.visible = false; // hunger bars off by default (toggle via the Hunger bars button)
platformGroup.add(barsGroup);

const barBgGeo = new THREE.PlaneGeometry(1, 1);
const barFillGeo = new THREE.PlaneGeometry(1, 1);
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x0c0f13, transparent: true, opacity: 0.65, depthWrite: false });
const _hue = new THREE.Color();
const hungerSated = new THREE.Color(0x33cc44), hungerStarving = new THREE.Color(0xdd3322);

function makeHungerBar(a) {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(barBgGeo, barBgMat);
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x33cc44, depthWrite: false });
  const fill = new THREE.Mesh(barFillGeo, fillMat);
  fill.position.z = 0.003; // sit in front of the background
  group.add(bg, fill);
  barsGroup.add(group);
  a.bar = { group, bg, fill, fillMat };
}

function updateHungerBar(a, hunger, maxH, mesh, topY) {
  const b = a.bar;
  const wbg = HUNGER.barWidth * (maxH / HUNGER.max); // capacity sets bar length
  const frac = maxH > 0 ? hunger / maxH : 0;
  b.bg.scale.set(wbg, HUNGER.barHeight, 1);
  const wfill = Math.max(0.0001, wbg * frac);
  b.fill.scale.set(wfill, HUNGER.barHeight * 0.7, 1);
  b.fill.position.x = -wbg / 2 + wfill / 2; // anchored to the left edge
  b.fillMat.color.copy(hungerStarving).lerp(hungerSated, frac); // red empty -> green full
  b.group.position.set(mesh.position.x, mesh.position.y + topY, mesh.position.z);
  b.group.quaternion.copy(camera.quaternion); // billboard toward the viewer
}

/* Begin dying: stop AI, switch to a per-body material we can fade, hide the bar. */
function killCreature(a) {
  const st = a.st;
  st.dead = true;
  st.decayTimer = 0;
  st.meat = CONFIG.predation.corpseMeat; // scavengers (insects) can feed on this
  st.consumed = false;
  // Clone each material so fading the corpse doesn't affect the living (who
  // share cached materials). A primitive model is one Mesh; a detailed model
  // is a Group of meshes — collect the fade targets either way.
  a.fadeMats = [];
  a.mesh.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material.clone();
    m.transparent = true;
    o.material = m;
    a.fadeMats.push(m);
  });
  if (a.bar) a.bar.group.visible = false;
}

function processCreatureHunger(list, fixedH, dt) {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i], st = a.st, mesh = a.mesh;
    const halfH = (fixedH != null ? fixedH : a.sp.height) / 2;

    if (st.dead) {
      // Decay: settle to the bottom/ground and fade out, then delete.
      const restY = sampleHeight(mesh.position.x, mesh.position.z) + halfH;
      mesh.position.y += (restY - mesh.position.y) * Math.min(1, dt * CONFIG.death.sinkRate);
      st.decayTimer += dt;
      const _op = Math.max(0, 1 - st.decayTimer / CONFIG.death.decayTime);
      if (a.fadeMats) for (const _m of a.fadeMats) _m.opacity = _op;
      if (st.decayTimer >= CONFIG.death.decayTime) {
        platformGroup.remove(mesh);
        if (a.bar) barsGroup.remove(a.bar.group);
        list.splice(i, 1);
        updateCreatureReadout();
      }
      continue;
    }

    const isBaby = st.mature === false; // only immature fish set this false
    const maxH = isBaby ? HUNGER.babyMax : HUNGER.max;
    if (st.hunger === undefined) {
      const f = HUNGER.startMinFrac + Math.random() * (HUNGER.startMaxFrac - HUNGER.startMinFrac);
      st.hunger = f * maxH;
    }
    st.hunger = Math.max(0, st.hunger - HUNGER.depleteRate * dt); // metabolism burns reserve
    st.maxHunger = maxH;

    // Starvation: out of reserve for too long -> death.
    if (st.hunger <= 0) {
      st.starveTimer = (st.starveTimer || 0) + dt;
      if (st.starveTimer >= CONFIG.death.starveTime) { killCreature(a); continue; }
    } else {
      st.starveTimer = 0;
    }

    if (barsGroup.visible) {
      if (!a.bar) makeHungerBar(a);
      updateHungerBar(a, st.hunger, maxH, mesh, halfH + 0.7);
    }
  }
}

function hungerTick(dt) {
  processCreatureHunger(fishes, FISH.height, dt);
  processCreatureHunger(frogs, FROG.height, dt);
  processCreatureHunger(birds, null, dt); // birds carry per-species height in a.sp
}

document.getElementById('toggle-bars').addEventListener('click', e => {
  barsGroup.visible = !barsGroup.visible;
  e.currentTarget.classList.toggle('active', barsGroup.visible);
});

document.getElementById('toggle-art').addEventListener('click', e => {
  artMode = artMode === 'detailed' ? 'primitive' : 'detailed';
  rebuildCreatureVisuals();
  e.currentTarget.classList.toggle('active', artMode === 'detailed');
  e.currentTarget.textContent = artMode === 'detailed' ? 'Detailed art' : 'Primitive art';
});

document.getElementById('toggle-grass').addEventListener('click', e => {
  grassMesh.visible = !grassMesh.visible;
  e.currentTarget.classList.toggle('active', grassMesh.visible);
});

/* ============================================================
 * AMBIENT MUSIC — generative, asset-free (Web Audio API).
 *
 * A slow evolving drone + pad with sparse pentatonic bell notes,
 * routed through a procedurally-generated reverb. No audio files:
 * everything is synthesized, so it stays tiny and copyright-free,
 * and it runs on the browser's audio thread (no main-loop cost).
 * Built lazily on first enable, because browsers block audio
 * until a user gesture.
 * ============================================================ */
const music = { ctx: null, master: null, on: false, want: true, vol: 0.5, rampFactor: 1, timer: null, nodes: [] };
const MENU_MUSIC_FACTOR = 0.28;  // quiet bed while the setup menu is up
const INTRO_RAMP_SECS   = 12;    // menu-level -> full as the scene comes to life
const musicFull = () => music.vol * 0.22; // full background level for the current volume dial
const _gClamp = v => Math.max(0.0001, v); // exponential/linear ramps dislike exact 0

function buildReverbIR(ctx, seconds = 2.6, decay = 2.2) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

function startMusic() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = music.ctx || (music.ctx = new Ctx());
    if (ctx.state === 'suspended') ctx.resume();

    // master -> reverb (wet) + dry -> destination
    const master = ctx.createGain();
    master.gain.value = 0;                       // fade in
    const reverb = ctx.createConvolver();
    reverb.buffer = buildReverbIR(ctx);
    const wet = ctx.createGain(); wet.gain.value = 0.5;
    const dry = ctx.createGain(); dry.gain.value = 0.6;
    master.connect(dry).connect(ctx.destination);
    master.connect(reverb).connect(wet).connect(ctx.destination);
    music.master = master;
    music.nodes = [];

    // Low drone: root + fifth, very quiet, slow shimmer.
    const droneFreqs = [55, 82.4]; // A1, E2
    for (const f of droneFreqs) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.08;
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.05 + Math.random() * 0.05;
      const lg = ctx.createGain(); lg.gain.value = 0.03;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(master);
      o.start(); lfo.start();
      music.nodes.push(o, lfo);
    }

    // Soft pad chord (A minor pentatonic-ish), gentle filter.
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 0.4;
    filt.connect(master);
    for (const f of [220, 261.6, 329.6]) { // A3, C4, E4
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 8;
      const g = ctx.createGain(); g.gain.value = 0.05;
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.06 + Math.random() * 0.08;
      const lg = ctx.createGain(); lg.gain.value = 0.04;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(filt);
      o.start(); lfo.start();
      music.nodes.push(o, lfo);
    }

    // Sparse bell melody — pentatonic over a couple of octaves.
    const scale = [220, 246.9, 293.7, 329.6, 392, 440, 493.9, 587.3]; // A pentatonic
    music.timer = setInterval(() => {
      if (!music.ctx || music.ctx.state !== 'running') return;
      if (Math.random() > 0.45) return; // leave space — sparse
      const now = ctx.currentTime;
      const f = scale[(Math.random() * scale.length) | 0];
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.12, now + 0.4);   // soft attack
      g.gain.exponentialRampToValueAtTime(0.0001, now + 3.5); // long release
      o.connect(g).connect(reverb); o.connect(g).connect(master);
      o.start(now); o.stop(now + 3.7);
    }, 1500);

    master.gain.setValueAtTime(0.0001, ctx.currentTime); // silent until a ramp is scheduled
    music.on = true;
  } catch (e) { /* audio unavailable: silently no-op */ }
}

/* Volume staging. Effective level = volume dial * 0.22 * rampFactor, so the
 * dial always scales whatever stage we're in. */
function rampMusicGain(toFactor, secs) {
  music.rampFactor = toFactor;
  if (!music.on || !music.master) return;
  const g = music.master.gain, now = music.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(_gClamp(g.value), now);
  g.linearRampToValueAtTime(_gClamp(musicFull() * toFactor), now + secs);
}

/* Scene intro: a quick fade in to the quiet menu bed, then a slow swell to
 * full as the world loads. Scheduled on the audio clock, so if the context is
 * still suspended (no user gesture yet) the swell simply begins the moment
 * audio is unlocked. */
function rampMusicIntro() {
  music.rampFactor = 1;
  if (!music.on || !music.master) return;
  const g = music.master.gain, now = music.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(0.0001, now);
  g.linearRampToValueAtTime(_gClamp(musicFull() * MENU_MUSIC_FACTOR), now + 1.5);
  g.linearRampToValueAtTime(_gClamp(musicFull()), now + 1.5 + INTRO_RAMP_SECS);
}

function stopMusic() {
  if (!music.ctx || !music.on) return;
  const ctx = music.ctx;
  music.master.gain.cancelScheduledValues(ctx.currentTime);
  music.master.gain.setValueAtTime(music.master.gain.value, ctx.currentTime);
  music.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
  clearInterval(music.timer); music.timer = null;
  setTimeout(() => { for (const n of music.nodes) { try { n.stop(); } catch {} } music.nodes = []; }, 900);
  music.on = false;
}

const musicBtn = document.getElementById('toggle-music');
function reflectMusicBtn() {
  musicBtn.classList.toggle('active', music.want);
  musicBtn.textContent = music.want ? '♪ Music: on' : '♪ Music: off';
}
musicBtn.addEventListener('click', () => {
  music.want = !music.want;
  reflectMusicBtn();
  if (!music.want) { stopMusic(); return; }
  if (!music.on) startMusic();
  if (music.ctx && music.ctx.state === 'suspended') music.ctx.resume();
  rampMusicGain(1, 1.5); // user turned it back on mid-scene: come up to full
});
bindSlider('music-vol', v => {
  music.vol = v;
  if (music.on && music.master) music.master.gain.setTargetAtTime(_gClamp(musicFull() * music.rampFactor), music.ctx.currentTime, 0.2);
}, v => v.toFixed(2));

/* Music is on by default. Browser autoplay rules forbid sound before a user
 * gesture, so we build the (silent) audio graph now, schedule the right
 * volume stage, and resume the context on the first interaction — at which
 * point the menu bed (or the scene swell) becomes audible. */
function primeMusic() {
  if (!music.want || music.on) return;
  startMusic();
  if (SETUP.go) rampMusicIntro();          // scene load: quiet -> full as it loads
  else          rampMusicGain(MENU_MUSIC_FACTOR, 2); // menu: settle to the quiet bed
}
function unlockAudio() {
  if (!music.want) return;
  primeMusic();
  if (music.ctx && music.ctx.state === 'suspended') music.ctx.resume();
}
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click']) {
  window.addEventListener(ev, unlockAudio, { once: false, capture: true });
}
reflectMusicBtn();
primeMusic(); // build + schedule now; stays silent until the gesture above resumes it

let timeScale = 1;
bindSlider('time-scale', v => { timeScale = v; }, v => v + '×');

/* ============================================================
 * CREATURE PLACEMENT  —  dropdown + Place tool
 * ============================================================ */
function updateCreatureReadout() {
  document.getElementById('r-fish').textContent  = fishes.length;
  document.getElementById('r-frogs').textContent = frogs.length;
  document.getElementById('r-birds').textContent = birds.length;
  document.getElementById('r-eggs').textContent  = eggs.length;
  document.getElementById('r-plants').textContent = plants.length;
}

function spawnCreatureAt(point) {
  const type = document.getElementById('creature-select').value;
  const reg = SPECIES[type];
  if (reg) reg.spawn(point.x, point.z);
}

/* ============================================================
 * POPULATION LOG + CHART  —  sample each species' living count
 * on a fixed sim-time interval, store it, and live-plot it.
 * ============================================================ */
const LOG_INTERVAL = 15; // sim seconds between logged samples
const POP_CAP = 1000;    // rolling window of samples
const popLog = [];       // { t, fish, frog, insect, plants }
let simElapsed = 0, nextLogAt = LOG_INTERVAL;

// Chart-line colours (chosen to read on the dark HUD — black creatures get
// a visible substitute). Keyed by species, so a new species just adds one.
const POP_SERIES = [
  { key: 'fish',    label: 'Fish',     color: '#ff5a4d' },
  { key: 'frog',    label: 'Frog',     color: '#36d65a' },
  { key: 'insect',  label: 'Insect',   color: '#6fd0ff' },
];
// Plants are logged alongside creatures but drawn against a SEPARATE right-hand
// axis: they outnumber animals ~100x, so sharing the left axis would flatten
// every creature line to the baseline. Dashed to read as "different units".
// PLANT_SERIES (one entry per plant species) is built up in the plant registry.
const PLANT_AXIS_COLOR = '#9be36b';

function countPops() {
  const c = { plants: plants.length };
  for (const k in SPECIES) c[k] = 0;       // include any JSON-registered creature species
  for (const k in PLANT_SPECIES) c[k] = 0; // ...and plant species
  let fr = 0, fg = 0, fb = 0; // accumulate fish gene colors for the average
  for (const a of fishes) if (!a.st.dead) {
    c[a.st.species]++;
    if (a.st.species === 'fish' && a.st.color) { fr += a.st.color.r; fg += a.st.color.g; fb += a.st.color.b; }
  }
  for (const a of frogs)  if (!a.st.dead) c[a.st.species]++;
  for (const a of birds)  if (!a.st.dead) c[a.st.species]++;
  for (const pl of plants) c[pl.sp.id]++;  // per plant-species totals
  // Average fish color as a hex string (null when no fish), logged per sample
  // so the chart can paint the fish line in the population's evolving color.
  c.fishColor = c.fish ? '#' + [fr, fg, fb].map(v => {
    const n = Math.round(Math.min(1, v / c.fish) * 255);
    return n.toString(16).padStart(2, '0');
  }).join('') : null;
  return c;
}

function logSample() {
  const s = countPops();
  s.t = simElapsed;
  popLog.push(s);
  if (popLog.length > POP_CAP) popLog.shift();
}

// Chart canvas (HiDPI-aware).
const chartCanvas = document.getElementById('chart-canvas');
const chartCtx = chartCanvas.getContext('2d');
const chartLegend = document.getElementById('chart-legend');
let chartW = 0, chartH = 0;
function sizeChart() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = chartCanvas.getBoundingClientRect();
  chartW = rect.width; chartH = rect.height;
  chartCanvas.width = Math.round(chartW * dpr);
  chartCanvas.height = Math.round(chartH * dpr);
  chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawChart() {
  if (chartPanel.classList.contains('collapsed')) return;
  if (chartW === 0) sizeChart();
  const ctx = chartCtx, w = chartW, h = chartH;
  ctx.clearRect(0, 0, w, h);

  // Live trailing point at the current instant so the plot animates.
  const live = countPops(); live.t = simElapsed;
  const series = popLog.length ? popLog.concat(live) : [live];

  const t0 = series[0].t, t1 = Math.max(series[series.length - 1].t, t0 + 1);
  let maxV = 5; // left axis: creatures only
  for (const s of series)
    for (const sp of POP_SERIES) maxV = Math.max(maxV, s[sp.key]);
  maxV = Math.ceil(maxV * 1.1);
  let maxP = 10; // right axis: plants (own scale — ~100x the creature counts)
  for (const s of series) for (const ps of PLANT_SERIES) maxP = Math.max(maxP, s[ps.key] || 0);
  maxP = Math.ceil(maxP * 1.1);

  const padL = 22, padB = 12, padT = 4, padR = 26; // padR widened for the plant axis
  const x = t => padL + (t - t0) / (t1 - t0) * (w - padL - padR);
  const y = v => padT + (1 - v / maxV) * (h - padT - padB);       // left (creatures)
  const yP = v => padT + (1 - v / maxP) * (h - padT - padB);      // right (plants)

  // Gridlines + y labels: left axis = creatures, right axis = plants.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.font = '9px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 2; g++) {
    const yy = y(Math.round(maxV * g / 2));
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(String(Math.round(maxV * g / 2)), 2, yy + 3);
    // right-axis plant tick (in the plant colour so the axis is self-labelling)
    ctx.fillStyle = PLANT_AXIS_COLOR;
    ctx.globalAlpha = 0.6;
    ctx.fillText(String(Math.round(maxP * g / 2)), w - padR + 3, yy + 3);
    ctx.globalAlpha = 1;
  }

  // Species polylines (left axis). The fish line is painted segment-by-segment
  // in the population's AVERAGE GENE COLOR at each sample, so the line literally
  // shows the lineage's color drifting over time; other species use a fixed hue.
  for (const sp of POP_SERIES) {
    ctx.lineWidth = 1.5;
    if (sp.key === 'fish') {
      let lastCol = sp.color;
      for (let i = 1; i < series.length; i++) {
        const a = series[i - 1], b = series[i];
        lastCol = b.fishColor || a.fishColor || lastCol;
        ctx.strokeStyle = lastCol;
        ctx.beginPath();
        ctx.moveTo(x(a.t), y(a.fish));
        ctx.lineTo(x(b.t), y(b.fish));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = sp.color;
      ctx.beginPath();
      series.forEach((s, i) => {
        const px = x(s.t), py = y(s[sp.key]);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }

  // Plant polylines (right axis, dashed to signal the separate scale) — one
  // per plant species in its own color.
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  for (const ps of PLANT_SERIES) {
    ctx.strokeStyle = ps.color;
    ctx.beginPath();
    series.forEach((s, i) => {
      const px = x(s.t), py = yP(s[ps.key] || 0);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Legend with current live counts (plants last, matching its separate axis).
  // The Fish swatch shows the live average gene color of the population.
  let html = '';
  for (const sp of POP_SERIES) {
    const swatch = sp.key === 'fish' ? (live.fishColor || sp.color) : sp.color;
    html += `<span class="lg"><span class="sw" style="background:${swatch}"></span>${sp.label}<b>${live[sp.key]}</b></span>`;
  }
  for (const ps of PLANT_SERIES) {
    html += `<span class="lg"><span class="sw" style="background:${ps.color}"></span>${ps.label}<b>${live[ps.key] || 0}</b></span>`;
  }
  chartLegend.innerHTML = html;
}

const chartPanel = document.getElementById('chart-panel');
if (IS_MOBILE) chartPanel.classList.add('collapsed'); // skip per-frame redraws on phones
document.getElementById('chart-head').addEventListener('click', e => {
  if (e.target.id === 'chart-clear') return; // handled separately
  chartPanel.classList.toggle('collapsed');
  document.getElementById('chart-toggle').textContent =
    chartPanel.classList.contains('collapsed') ? '▸' : '▾';
  if (!chartPanel.classList.contains('collapsed')) { sizeChart(); drawChart(); }
});
document.getElementById('chart-clear').addEventListener('click', () => {
  popLog.length = 0; simElapsed = 0; nextLogAt = LOG_INTERVAL; drawChart();
});
window.addEventListener('resize', () => { chartW = 0; }); // re-measure on next draw
sizeChart();

/* Generic minimize toggles — any .min-toggle with data-collapse="<id>"
 * toggles .collapsed on the target element and flips its own arrow. */
document.addEventListener('click', e => {
  const toggle = e.target.closest('.min-toggle');
  if (!toggle) return;
  const id = toggle.dataset.collapse;
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('collapsed');
  // Flip arrow text (▾ ↔ ▸), except for the hint "?" which stays.
  if (toggle.textContent === '▾') toggle.textContent = '▸';
  else if (toggle.textContent === '▸') toggle.textContent = '▾';
});

/* Draggable HUD panels — drag by title bars (.drag-handle) or any
 * non-interactive area. On first drag, pins the panel to left/top
 * and clears right/bottom so it can be freely positioned. */
const DRAGGABLE_IDS = ['readout', 'terrain-panel', 'chart-panel', 'views', 'hint', 'config-panel'];
{
  let dragEl = null, dragOffX = 0, dragOffY = 0;

  function pinToLeftTop(el) {
    if (el.dataset.pinned) return;
    const r = el.getBoundingClientRect();
    el.style.left = r.left + 'px';
    el.style.top  = r.top + 'px';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    el.classList.add('draggable');
    el.dataset.pinned = '1';
  }

  function isInteractive(target) {
    const tag = target.tagName;
    return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'LABEL'
      || target.classList.contains('min-toggle') || target.classList.contains('ctl');
  }

  document.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (isInteractive(e.target)) return;
    // Find a drag handle or the HUD itself.
    const handle = e.target.closest('.drag-handle');
    const hud = e.target.closest('.hud');
    if (!hud || !DRAGGABLE_IDS.includes(hud.id)) return;
    // For panels with a drag-handle, only drag from the handle.
    // For panels without (views, hint), drag from anywhere non-interactive.
    if (hud.querySelector('.drag-handle') && !handle) return;
    pinToLeftTop(hud);
    dragEl = hud;
    const r = hud.getBoundingClientRect();
    dragOffX = e.clientX - r.left;
    dragOffY = e.clientY - r.top;
    hud.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('pointermove', e => {
    if (!dragEl) return;
    const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - dragOffX));
    const y = Math.max(0, Math.min(window.innerHeight - 20, e.clientY - dragOffY));
    dragEl.style.left = x + 'px';
    dragEl.style.top  = y + 'px';
  });

  document.addEventListener('pointerup', () => {
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null;
  });
}

let chartAccum = 0; // throttle live redraws (real time)
function populationTick(simDt, realDt) {
  simElapsed += simDt;
  if (simElapsed >= nextLogAt) {
    logSample();
    nextLogAt += LOG_INTERVAL;
    while (simElapsed >= nextLogAt) { logSample(); nextLogAt += LOG_INTERVAL; } // catch up at high speed
  }
  chartAccum += realDt;
  if (chartAccum >= 0.2) { drawChart(); chartAccum = 0; }
}

/* ============================================================
 * VIEW SNAPPING  —  standard orthographic-style camera presets
 * ============================================================ */
const VIEWS = {
  // [x, y, z] direction of camera from FOCUS, scaled by R.
  top:   new THREE.Vector3(0.0001, 1, 0).normalize(),
  front: new THREE.Vector3(0, 0, 1),
  back:  new THREE.Vector3(0, 0, -1),
  left:  new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  iso:   new THREE.Vector3(1, 0.85, 1).normalize(),
};

let activeView = 'iso';
let tween = null; // { fromPos, toPos, fromTgt, toTgt, start }
const _tmpTgt = new THREE.Vector3();

function setActiveUI(name) {
  document.querySelectorAll('#views button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  document.getElementById('r-view').textContent = name;
}

/* Start a tween of both the eye position and the orbit target, so standard
 * views recentre on FOCUS. */
function startTween(toPos, toTgt, name) {
  tween = {
    fromPos: camera.position.clone(), toPos: toPos.clone(),
    fromTgt: controls.target.clone(), toTgt: toTgt.clone(),
    start: performance.now(),
  };
  controls.enabled = false; // hand control to the tween, restore on completion
  activeView = name;
  setActiveUI(name);
}

function snapTo(name) {
  const dir = VIEWS[name];
  if (!dir) return;
  controls.maxPolarAngle = Math.PI * 0.495; // keep overhead views above the ground plane
  startTween(FOCUS.clone().addScaledVector(dir, R), FOCUS, name);
}

const smoothstep = t => t * t * (3 - 2 * t);

/* Wire up buttons + number-key shortcuts. */
const viewOrder = ['top', 'front', 'back', 'left', 'right', 'iso'];
document.getElementById('views').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  snapTo(btn.dataset.view);
});
window.addEventListener('keydown', e => {
  if (possessed) return;
  const i = parseInt(e.key, 10) - 1;
  if (i >= 0 && i < viewOrder.length) snapTo(viewOrder[i]);
});

/* ============================================================
 * CREATURE POV  —  first-person possession of a creature.
 * Right-click a creature → "POV" → camera snaps to its eye
 * level, WASD drives it, mouse-look via pointer lock.
 * ============================================================ */
let possessed = null;       // agent { mesh, st } being possessed
let povYaw = 0;
let povPitch = 0;
const povKeys = { w: false, a: false, s: false, d: false };
let savedCamera = null;
let povCfg = null;          // resolved per-creature camera params for the active POV
const POV_DEG = Math.PI / 180;

/* Per-creature POV camera params (config/species/<id>.json "pov"). forward/
 * height/lateral place the eye anchor (handled at build time); pitch/yaw/roll
 * tilt the look (radians here), fov is the lens, and dof/vignette/fog drive the
 * post effects. Missing fields fall back to a neutral, effect-free camera. */
function povParams(species) {
  const pv = (SPECIES_DEFS[species] && SPECIES_DEFS[species].pov) || {};
  return {
    pitch: (pv.pitch || 0) * POV_DEG,
    yaw:   (pv.yaw   || 0) * POV_DEG,
    roll:  (pv.roll  || 0) * POV_DEG,
    fov:   pv.fov != null ? pv.fov : CONFIG.camera.fov,
    dof:   pv.dof || 0,
    vignette: pv.vignette || 0,
    fog:   pv.fog || 0,
  };
}

/* Lazy postprocessing chain, only built/used while a creature with DoF or
 * vignette is possessed (normal play renders straight through renderer.render). */
let povComposer = null, povBokeh = null, povVignette = null;
function ensurePovComposer() {
  if (povComposer) return;
  povComposer = new EffectComposer(renderer);
  povComposer.addPass(new RenderPass(scene, camera));
  povBokeh = new BokehPass(scene, camera, { focus: 5, aperture: 0, maxblur: 0.012 });
  povVignette = new ShaderPass(VignetteShader);
  povVignette.uniforms.offset.value = 1.1;
  povComposer.addPass(povBokeh);
  povComposer.addPass(povVignette);
  povComposer.setSize(window.innerWidth, window.innerHeight);
}

function getCreatureEyeHeight(st) {
  if (st.species === 'fish' || SPECIES[st.species]?.list === fishes) return FISH.height;
  if (st.species === 'frog' || SPECIES[st.species]?.list === frogs)  return FROG.height;
  const fl = FLIERS[st.species];
  return fl ? fl.cfg.height : FLIER_BASE.height;
}

function getCreatureSpeed(st) {
  if (st.species === 'fish' || SPECIES[st.species]?.list === fishes) return FISH.speed;
  if (st.species === 'frog' || SPECIES[st.species]?.list === frogs)  return FROG.hopHoriz;
  const fl = FLIERS[st.species];
  if (fl) return st.mode === 'fly' ? fl.cfg.flySpeed : fl.cfg.walkSpeed;
  return FLIER_BASE.walkSpeed;
}

function enterPOV(agent) {
  hideCreatureMenu();
  possessed = agent;
  agent.st.aiSuspended = true;
  povYaw = agent.st.heading;
  povPitch = 0;
  povCfg = povParams(agent.st.species);
  savedCamera = {
    position: camera.position.clone(),
    target: controls.target.clone(),
    maxPolarAngle: controls.maxPolarAngle,
    designFov: designFov,
    fogNear: scene.fog ? scene.fog.near : null,
    fogFar: scene.fog ? scene.fog.far : null,
  };
  designFov = povCfg.fov;
  applyFov();
  if (povCfg.dof > 0 || povCfg.vignette > 0) ensurePovComposer();
  controls.enabled = false;
  activeView = 'pov';
  setActiveUI('pov');
  document.body.classList.add('pov-active');
  renderer.domElement.requestPointerLock();
}

function exitPOV() {
  if (!possessed) return;
  possessed.st.aiSuspended = false;
  possessed = null;
  Object.keys(povKeys).forEach(k => povKeys[k] = false);
  if (document.pointerLockElement) document.exitPointerLock();
  if (savedCamera) {
    camera.position.copy(savedCamera.position);
    controls.target.copy(savedCamera.target);
    controls.maxPolarAngle = savedCamera.maxPolarAngle;
    designFov = savedCamera.designFov;
    applyFov();
    if (scene.fog && savedCamera.fogNear != null) {
      scene.fog.near = savedCamera.fogNear; scene.fog.far = savedCamera.fogFar;
    }
  }
  camera.up.set(0, 1, 0);   // clear any POV roll
  povCfg = null;
  controls.enabled = true;
  document.body.classList.remove('pov-active');
  activeView = 'iso';
  setActiveUI('iso');
}

// Handle pointer lock loss (e.g. user presses Escape via browser).
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && possessed) exitPOV();
});

// Mouse look while pointer-locked.
document.addEventListener('mousemove', e => {
  if (!possessed) return;
  povYaw   += e.movementX * 0.002; // mouse right → look right (H=(cos,0,sin) convention)
  povPitch -= e.movementY * 0.002;
  povPitch  = Math.max(-Math.PI * 0.47, Math.min(Math.PI * 0.47, povPitch));
});

// Menu "POV" button.
creatureMenu.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.action === 'pov' && menuAgent && !menuAgent.st.dead) {
    enterPOV(menuAgent);
  }
  hideCreatureMenu();
});

/* Per-frame POV update — called from animate(). Drives the possessed
 * creature with WASD and positions the camera at its eye level. */
function povTick(dt) {
  if (!possessed) return;
  if (possessed.st.dead) { exitPOV(); return; }

  const mesh = possessed.mesh;
  const st = possessed.st;
  const speed = getCreatureSpeed(st);
  const eyeH = getCreatureEyeHeight(st);

  const isFish = st.species === 'fish' || SPECIES[st.species]?.list === fishes;
  const isBirdFlying = (SPECIES[st.species]?.list === birds) && st.mode === 'fly';

  let nx, ny, nz;

  if (isFish) {
    // Fish POV: mouse steers yaw + pitch, W is forward thrust, S does nothing.
    // Use full camera pitch (not clamped to pitchMax) for responsive control.
    const cosPitch = Math.cos(povPitch);
    const sinPitch = Math.sin(povPitch);
    const fwd = new THREE.Vector3(
      Math.cos(povYaw) * cosPitch,
      sinPitch,
      Math.sin(povYaw) * cosPitch
    );
    const throttle = povKeys.w ? 1 : 0;
    nx = mesh.position.x + fwd.x * speed * throttle * dt;
    ny = mesh.position.y + fwd.y * speed * throttle * dt;
    nz = mesh.position.z + fwd.z * speed * throttle * dt;

    // Clamp to navigable water volume.
    nx = Math.max(-agentBoundX, Math.min(agentBoundX, nx));
    nz = Math.max(-agentBoundZ, Math.min(agentBoundZ, nz));
    const depth = water.level - sampleHeight(nx, nz);
    if (depth < FISH.height) { nx = mesh.position.x; nz = mesh.position.z; }
    const floorY = sampleHeight(nx, nz) + FISH.height / 2 + 0.1;
    const ceilY  = water.level - FISH.height / 2 - 0.1;
    ny = Math.max(floorY, Math.min(ceilY, ny));

    st.pitch = povPitch;
    st.heading = povYaw;
    mesh.position.set(nx, ny, nz);
    orientFish(mesh, povYaw, st.pitch, dt);
  } else {
    // Ground/air creatures: standard WASD. Forward is the heading direction
    // H=(cos,0,sin) — the same convention as orientFish and normal movement —
    // so the snout, the camera look, and W all point the same way.
    const fwd = new THREE.Vector3(Math.cos(povYaw), 0, Math.sin(povYaw));
    const right = new THREE.Vector3(-Math.sin(povYaw), 0, Math.cos(povYaw));
    const move = new THREE.Vector3();
    if (povKeys.w) move.add(fwd);
    if (povKeys.s) move.sub(fwd);
    if (povKeys.d) move.add(right);
    if (povKeys.a) move.sub(right);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);

    nx = Math.max(-agentBoundX, Math.min(agentBoundX, mesh.position.x + move.x));
    nz = Math.max(-agentBoundZ, Math.min(agentBoundZ, mesh.position.z + move.z));

    if (isBirdFlying) {
      ny = mesh.position.y + move.y;
      ny = Math.max(sampleHeight(nx, nz) + eyeH, ny);
    } else {
      ny = sampleHeight(nx, nz) + eyeH / 2;
    }

    st.heading = povYaw;
    mesh.position.set(nx, ny, nz);
    mesh.rotation.y = -povYaw; // snout (+X) points along H=(cos,0,sin), matching the look dir
  }

  // Camera at the creature's eye point: snap to the model's eyeAnchor (placed at
  // the per-species eye/head position, so it tracks scale + seating + heading),
  // falling back to the old body-centre estimate for primitive-art / anchorless
  // models.
  const anchor = mesh.getObjectByName('eyeAnchor');
  if (anchor) {
    mesh.updateWorldMatrix(true, true);
    anchor.getWorldPosition(camera.position);
  } else {
    camera.position.set(nx, ny + eyeH / 2, nz);
  }
  // Look along the heading, plus the creature's per-species pitch/yaw offsets;
  // roll tilts the horizon by rolling the up-vector about the view axis.
  const yaw   = povYaw   + (povCfg ? povCfg.yaw   : 0);
  const pitch = povPitch + (povCfg ? povCfg.pitch : 0);
  const lookDir = new THREE.Vector3(
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.sin(yaw) * Math.cos(pitch)
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(camera.position.clone().add(lookDir));
  const roll = povCfg ? povCfg.roll : 0;
  if (roll) camera.rotateZ(roll); // tilt horizon, same convention as the editor's grab
}

/* ============================================================
 * READOUT  +  RESIZE
 * ============================================================ */
document.getElementById('r-size').textContent = `${P.width}×${P.depth}`;

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  applyFov(); // keep horizontal FOV constant across widths (updates projection)
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (povComposer) povComposer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

/* ============================================================
 * LOOP
 * ============================================================ */
let lastFps = performance.now(), frames = 0;
const fpsEl = document.getElementById('r-fps');
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp after tab-switch stalls

  // Camera tween (overrides user control while running)
  if (tween) {
    const e = (performance.now() - tween.start) / CONFIG.tween.duration;
    const k = e >= 1 ? 1 : smoothstep(e);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
    _tmpTgt.lerpVectors(tween.fromTgt, tween.toTgt, k);
    camera.lookAt(_tmpTgt);
    if (e >= 1) { controls.target.copy(tween.toTgt); tween = null; controls.enabled = true; }
  }

  // Sculpt brush stays real-time (it's user editing, not simulation).
  brushTick(dt);

  // Simulation runs at dt x timeScale, sub-stepped so ballistic physics
  // (hops, flops, gravity) stays stable even at 100x. Only the MOVEMENT
  // integrators need sub-stepping; the slow linear systems (vegetation,
  // eggs, metabolism) are mathematically identical run once with the full
  // simDt — proven equivalent — so they run a single time per frame instead
  // of N times, the dominant CPU saving at high sim speed.
  const simDt = dt * timeScale;
  const steps = Math.max(1, Math.min(PERF.maxSubsteps, Math.ceil(simDt / 0.02)));
  const stepDt = simDt / steps;
  for (let s = 0; s < steps; s++) {
    fishTick(stepDt);
    frogTick(stepDt);
    birdTick(stepDt);
  }
  // Slow systems: once per frame with the full simDt (see note above).
  vegTick(simDt);
  // Carrying capacity: recompute + die-back on its own coarse cadence (an O(plants)
  // pass, so not every frame), accumulating sim-time across frames.
  soilAccum += simDt;
  if (soilAccum >= SOIL.interval) { soilTick(soilAccum); soilAccum = 0; }
  eggTick(simDt);
  hungerTick(simDt);

  populationTick(simDt, dt); // log every 15 sim-s, live-redraw the chart
  vegVisualTick();           // GPU instance writes: once per frame, changed plants only
  grassUniforms.uTime.value += dt; // wind sway (cosmetic: real time, not sim-scaled)
  // Skeletal creature animation (fish tail-undulation, frog idle): advance each
  // live creature's mixer. Real-time based, mildly sped up with the sim so
  // fast-forward creatures still animate faster.
  const animDt = dt * Math.min(6, Math.max(1, timeScale));
  for (const a of fishes) { if (!a.st.dead && a.mesh.userData.mixer) a.mesh.userData.mixer.update(animDt); }
  for (const a of frogs)  { if (!a.st.dead && a.mesh.userData.mixer) a.mesh.userData.mixer.update(animDt); }
  for (const a of birds)  { if (!a.st.dead && a.mesh.userData.mixer) a.mesh.userData.mixer.update(animDt); } // beetle scurry
  // Rebuild grass to match painted soil, once the stroke ends (deterministic
  // layout means only the painted patches change, not the whole field).
  if (grassDirty && !brush.painting) generateGrass();

  povTick(dt);               // POV possession: real-time dt, not sim-scaled
  trackCreatureMenu();       // keep context menu pinned to the creature

  if (!possessed) controls.update();

  // Underwater visual effect: tint + fog scaled by water opacity.
  const camUnderwater = water.level > 0 && camera.position.y < water.level;
  if (camUnderwater) {
    // Lerp fog range: crystal clear (opacity 0) = 20..200, thick (opacity 1) = 1..20
    const uw = waterOpacity;
    scene.background = underwaterColor;
    scene.fog.color.copy(underwaterColor);
    scene.fog.near = 20 - 19 * uw;    // 20 → 1
    scene.fog.far  = 200 - 180 * uw;  // 200 → 20
  }
  // POV distance haze: pull the fog in (on top of the normal range) so it reads
  // as atmosphere from the creature's eye. Skipped while underwater (water owns
  // the fog then).
  let povFog = false;
  if (possessed && povCfg && povCfg.fog > 0 && !camUnderwater) {
    scene.fog.far = THREE.MathUtils.lerp(fogFar, fogNear + 4, povCfg.fog);
    povFog = true;
  }
  // Route through the post composer only when a possessed creature actually has
  // DoF or vignette; everything else renders straight (no overhead).
  if (possessed && povCfg && povComposer && (povCfg.dof > 0 || povCfg.vignette > 0)) {
    try {
      povBokeh.enabled = povCfg.dof > 0;
      if (povCfg.dof > 0) {
        povBokeh.uniforms['focus'].value = 6;
        povBokeh.uniforms['aperture'].value = povCfg.dof * 0.0006;
        povBokeh.uniforms['maxblur'].value = povCfg.dof * 0.02;
      }
      povVignette.enabled = povCfg.vignette > 0;
      povVignette.uniforms.darkness.value = povCfg.vignette * 1.6;
      povComposer.render();
    } catch (e) { renderer.render(scene, camera); }
  } else {
    renderer.render(scene, camera);
  }
  if (camUnderwater) {
    scene.background = bg0;
    scene.fog.color.copy(bg0);
    scene.fog.near = fogNear;
    scene.fog.far  = fogFar;
  } else if (povFog) {
    scene.fog.far = fogFar;
  }

  // FPS counter (updated ~once/sec)
  frames++;
  const now = performance.now();
  if (now - lastFps >= 1000) {
    fpsEl.textContent = Math.round((frames * 1000) / (now - lastFps));
    frames = 0; lastFps = now;
  }
}

/* Start at the iso working angle, with a freshly generated island. */
/* Start at the iso working angle. The camera frame is set regardless so the
 * static scene behind the menu (and the first run frame) is composed. */
camera.position.copy(FOCUS.clone().addScaledVector(VIEWS.iso, R));
camera.lookAt(FOCUS);

/* Reflect the chosen setup values in the in-sim sliders before they're read
 * by generateIsland / setWaterLevel. */
function applySetupToSliders() {
  const amp = document.getElementById('island-amp');
  const wat = document.getElementById('water-level');
  // worldHeight is the ceiling for both relief and fill, so the in-sim
  // sliders can't be dragged past the wall height.
  amp.max = worldHeight; wat.max = worldHeight;
  amp.value = Math.min(SETUP.amplitude, worldHeight); amp.dispatchEvent(new Event('input'));
  wat.value = Math.min(SETUP.water, worldHeight);     wat.dispatchEvent(new Event('input'));
}

function startSimulation() {
  applySetupToSliders();
  generateIsland(); // builds terrain at SETUP amplitude, then the veg layer at vegLevel
  spawnFishRandom(); // one starter fish in deep water (beaches if there is none)
  spawnFrogRandom(); // one starter frog on dry land (swims for it if submerged)
  spawnBirdRandom('insect');  // the lone flier
  animate();
}

/* ---- Setup menu wiring ---- */
const setupEl = document.getElementById('setup');

/* Styled hover tooltips. Any element carrying data-tip-title / data-tip-body
 * gets a floating card with a heading + description. The card is appended to
 * <body> and positioned with fixed coords near the cursor, so the setup panel's
 * `overflow-y:auto` can't clip it (the reason native title was used before).
 * One delegated listener covers both the static setup rows and the dynamically
 * built terrain knobs. */
function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.innerHTML = '<div class="tt-head"></div><div class="tt-body"></div>';
  tip.style.display = 'none';
  document.body.appendChild(tip);
  const head = tip.querySelector('.tt-head');
  const body = tip.querySelector('.tt-body');
  let target = null;

  const place = (x, y) => {
    const pad = 16, w = tip.offsetWidth, h = tip.offsetHeight, vw = innerWidth, vh = innerHeight;
    let left = x + pad, top = y + pad;
    if (left + w > vw - 8) left = x - pad - w; // flip to the cursor's left near the right edge
    if (top + h > vh - 8)  top = y - pad - h;  // flip above near the bottom edge
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top  = Math.max(8, top) + 'px';
  };
  const show = (el, x, y) => {
    head.textContent = el.dataset.tipTitle || '';
    body.textContent = el.dataset.tipBody || '';
    head.style.display = head.textContent ? '' : 'none';
    tip.style.display = 'block';
    place(x, y);
  };
  const hide = () => { target = null; tip.style.display = 'none'; };

  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip-body],[data-tip-title]');
    if (t && t !== target) { target = t; show(t, e.clientX, e.clientY); }
  });
  document.addEventListener('mousemove', e => { if (target) place(e.clientX, e.clientY); });
  document.addEventListener('mouseout', e => {
    if (target && !(e.relatedTarget && target.contains(e.relatedTarget))) hide();
  });
  // Don't leave a tooltip stranded when the cursor leaves the window / on scroll.
  document.addEventListener('mouseleave', hide);
  window.addEventListener('scroll', hide, true);
}
initTooltips();

/* Render the advanced terrain controls from TERRAIN_KNOB_GROUPS, pre-filled from
 * the (possibly hash-patched) CONFIG.terrain. Each slider keeps its readout in
 * sync; collection back into the hash happens in the su-go handler. */
function buildTerrainKnobUI() {
  const body = document.getElementById('su-adv-body');
  if (!body) return;
  body.innerHTML = '';
  for (const g of TERRAIN_KNOB_GROUPS) {
    const head = document.createElement('div');
    head.className = 'grp head';
    head.textContent = g.title;
    body.appendChild(head);
    for (const k of g.knobs) {
      const row = document.createElement('div');
      row.className = 'grp ctl';
      row.dataset.tipTitle = k.label;   // styled tooltip: heading…
      if (k.tip) row.dataset.tipBody = k.tip; // …+ description (see initTooltips)
      const val = CONFIG.terrain[k.key];
      row.innerHTML =
        `<label>${k.label}</label>` +
        `<input id="su-t-${k.key}" type="range" min="${k.min}" max="${k.max}" step="${k.step}" value="${val}">` +
        `<span class="val" id="su-t-${k.key}-v">${(+val).toFixed(k.dp)}</span>`;
      body.appendChild(row);
      const input = row.querySelector('input');
      const out   = row.querySelector('.val');
      input.addEventListener('input', () => { out.textContent = (+input.value).toFixed(k.dp); });
    }
  }
}

/* Apply a world preset to the setup sliders. Resets every terrain knob to its
 * default first so presets are absolute (not additive on prior tweaks), then
 * lays the preset's overrides over the top, and nudges the basic amp/water
 * sliders. su-go reads the slider values, so this is all that's needed. */
function applyTerrainPreset(preset) {
  const $ = id => document.getElementById(id);
  const vals = Object.assign({}, DEFAULT_TERRAIN, preset.terrain || {});
  for (const k of TERRAIN_KNOBS) {
    const input = $('su-t-' + k.key);
    if (!input) continue;
    const v = Math.min(k.max, Math.max(k.min, vals[k.key]));
    input.value = v;
    const out = $('su-t-' + k.key + '-v');
    if (out) out.textContent = (+v).toFixed(k.dp);
  }
  if (preset.amp   != null) $('su-amp').value   = preset.amp;
  if (preset.water != null) $('su-water').value = preset.water;
  // Re-run the basic-slider refresh (clamps to height, updates readouts).
  $('su-amp').dispatchEvent(new Event('input'));
  $('su-water').dispatchEvent(new Event('input'));
}

/* Render the preset chips. Clicking one applies it, marks it active, and opens
 * the advanced section so the resulting knob values are visible. */
function buildPresetUI() {
  const host = document.getElementById('su-presets');
  if (!host) return;
  host.innerHTML = '';
  const buttons = [];
  for (const preset of TERRAIN_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = preset.label;
    btn.dataset.tipTitle = preset.label;
    btn.dataset.tipBody = preset.tip;
    btn.addEventListener('click', () => {
      applyTerrainPreset(preset);
      for (const b of buttons) b.classList.toggle('active', b === btn);
      const adv = document.getElementById('su-adv');
      if (adv) adv.open = true;
    });
    buttons.push(btn);
    host.appendChild(btn);
  }
}

function wireSetup() {
  const ids = ['su-width','su-length','su-height','su-amp','su-water','su-veg'];
  const $ = id => document.getElementById(id);
  // Pre-fill from SETUP (which reflects hash values or defaults).
  $('su-width').value  = Math.round(SETUP.width);
  $('su-length').value = Math.round(SETUP.length);
  $('su-height').value = SETUP.height;
  $('su-amp').value    = SETUP.amplitude;
  $('su-water').value  = SETUP.water;
  $('su-veg').value    = SETUP.vegetation;
  const refresh = () => {
    // Height is the world's vertical extent: amplitude and water can't exceed
    // the walls, so their slider ceilings track it (and current values clamp).
    const hgt = Math.max(2, +$('su-height').value || 20);
    for (const id of ['su-amp','su-water']) {
      const el = $(id); el.max = hgt;
      if (+el.value > hgt) el.value = hgt;
    }
    $('su-amp-v').textContent   = parseFloat($('su-amp').value).toFixed(1);
    $('su-water-v').textContent = parseFloat($('su-water').value).toFixed(2);
    $('su-veg-v').textContent   = parseFloat($('su-veg').value).toFixed(2);
    const w = Math.round(+$('su-width').value), l = Math.round(+$('su-length').value);
    const cells = Math.max(1, w) * Math.max(1, l);
    $('su-est').textContent = `${w} x ${l} grid - ${(cells/1000).toFixed(0)}k cells, ${Math.ceil(w/32)*Math.ceil(l/32)} chunks, walls ${hgt} tall`;
  };
  ids.forEach(id => $(id).addEventListener('input', refresh));
  refresh();
  // World presets + advanced terrain knobs.
  buildPresetUI();
  buildTerrainKnobUI();
  const resetBtn = $('su-adv-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    for (const k of TERRAIN_KNOBS) {
      const input = $('su-t-' + k.key);
      if (!input) continue;
      input.value = DEFAULT_TERRAIN[k.key];
      $('su-t-' + k.key + '-v').textContent = (+DEFAULT_TERRAIN[k.key]).toFixed(k.dp);
    }
  });
  $('su-go').addEventListener('click', () => {
    const p = new URLSearchParams({
      go: '1',
      w:   String(Math.max(4, Math.round(+$('su-width').value)  || 480)),
      l:   String(Math.max(4, Math.round(+$('su-length').value) || 320)),
      h:   String(Math.max(0, +$('su-height').value || 20)),
      amp: $('su-amp').value,
      water: $('su-water').value,
      veg: $('su-veg').value,
    });
    // Carry the advanced terrain knobs through the same hash→reload path.
    for (const k of TERRAIN_KNOBS) {
      const input = $('su-t-' + k.key);
      if (input) p.set(k.key, input.value);
    }
    try {
      location.hash = p.toString();
      location.reload(); // rebuild at the chosen dimensions
    } catch (e) {
      // Sandboxed contexts may block reload; fall back to an in-place run with
      // whatever structural defaults were already built, applying the dials.
      console.warn('reload blocked; starting with current build', e);
      SETUP.amplitude = +$('su-amp').value;
      SETUP.water = +$('su-water').value;
      vegLevel = +$('su-veg').value;
      for (const k of TERRAIN_KNOBS) {
        const input = $('su-t-' + k.key);
        if (input) { const v = parseFloat(input.value); if (Number.isFinite(v)) CONFIG.terrain[k.key] = v; }
      }
      setupEl.classList.add('hidden');
      startSimulation();
    }
  });
}

// Fill the Vegetation brush picker from the plant registry (built-in + JSON).
function populatePlantPicker() {
  const sel = document.getElementById('plant-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (const ps of PLANT_SERIES) {
    const o = document.createElement('option');
    o.value = ps.key; o.textContent = ps.label;
    sel.appendChild(o);
  }
}

// Species/config files load asynchronously (served over http), so boot once
// they're in. Built-ins still work even if custom species fail to load.
/* ============================================================
 * LIVE CONFIG EDITOR
 *
 * An expandable HUD panel that exposes world.js (CONFIG) and every
 * config/species/*.json for live tweaking — no edit/push/redeploy loop.
 *
 *  - World knobs mutate CONFIG in place. Because the engine reads most
 *    tuning by reference each tick (FROG, FISH, PRED, etc.),
 *    these take effect immediately. Structural knobs (platform / grid /
 *    terrain size / fence / camera) are baked into geometry at startup,
 *    so they only re-apply after "New world…".
 *  - Species edits re-apply numeric cfg/breeding to the engine's live
 *    objects (FLIERS[id].cfg is shared by reference with spawned fliers,
 *    so flight/walk changes hit existing creatures too). Color, model and
 *    hitbox are built at load and need a reload to change.
 *  - "Copy" yields text you can paste back into the real file to persist;
 *    nothing here writes to disk (it's a static site).
 * ============================================================ */
const CONFIG_STRUCTURAL = new Set(['platform', 'grid', 'terrain', 'fence', 'camera']);
let CONFIG_BASELINE = null; // deep snapshot for the World "Reset" button

function deepAssign(target, src) {
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)
        && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepAssign(target[k], sv);
    } else {
      target[k] = Array.isArray(sv) ? sv.slice() : sv;
    }
  }
}

function setConfigStatus(msg) {
  const el = document.getElementById('config-status');
  if (el) el.textContent = msg || '';
}

async function copyToClipboard(text, okMsg) {
  try { await navigator.clipboard.writeText(text); setConfigStatus(okMsg || 'Copied to clipboard.'); }
  catch { setConfigStatus('Copy failed — select the text and copy manually.'); }
}

// One editable row for a primitive leaf; mutates obj[key] live on input.
function configLeafRow(obj, key) {
  const v = obj[key];
  const row = document.createElement('label');
  row.className = 'cfg-row';
  const name = document.createElement('span');
  name.textContent = key;
  name.title = key;
  row.appendChild(name);

  const input = document.createElement('input');
  input.className = 'cfg-in';
  if (typeof v === 'boolean') {
    input.type = 'checkbox';
    input.checked = v;
    input.addEventListener('change', () => { obj[key] = input.checked; });
  } else if (typeof v === 'number' && /colou?r/i.test(key)) {
    input.type = 'color';
    input.value = '#' + (v & 0xffffff).toString(16).padStart(6, '0');
    input.addEventListener('input', () => { obj[key] = parseInt(input.value.slice(1), 16); });
  } else if (typeof v === 'number') {
    input.type = 'number';
    input.step = 'any';
    input.value = String(v);
    input.addEventListener('input', () => {
      const n = parseFloat(input.value);
      if (Number.isFinite(n)) obj[key] = n;
    });
  } else {
    input.type = 'text';
    input.value = v == null ? '' : String(v);
    input.addEventListener('change', () => { obj[key] = input.value; });
  }
  row.appendChild(input);
  return row;
}

// Recursively render a plain object into collapsible sections + leaf rows.
function renderConfigObject(obj, container, structuralHint = false) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sec = document.createElement('div');
      sec.className = 'cfg-sec';
      const head = document.createElement('div');
      head.className = 'cfg-sec-h';
      head.textContent = structuralHint && CONFIG_STRUCTURAL.has(key) ? key + ' (New world)' : key;
      const body = document.createElement('div');
      body.className = 'cfg-sec-body';
      head.addEventListener('click', () => sec.classList.toggle('collapsed'));
      sec.append(head, body);
      sec.classList.add('collapsed'); // start folded; the panel can get tall
      container.appendChild(sec);
      renderConfigObject(val, body);
    } else if (typeof val !== 'object') {
      container.appendChild(configLeafRow(obj, key));
    }
  }
}

function renderWorldEditor(body, note) {
  note.textContent = 'world.js — most knobs apply live. Structural groups (platform, grid, '
    + 'terrain, fence, camera) take effect after New world…';
  renderConfigObject(CONFIG, body, true);
  const tools = document.createElement('div');
  tools.className = 'btn-row';
  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.title = 'Restore the values this session started with';
  reset.addEventListener('click', () => {
    if (CONFIG_BASELINE) deepAssign(CONFIG, CONFIG_BASELINE);
    renderConfigTarget('world'); // rebuild inputs to show restored values
    setConfigStatus('Reset to session start.');
  });
  const copy = document.createElement('button');
  copy.textContent = 'Copy JSON';
  copy.title = 'Copy the full CONFIG as JSON to paste back into world.js';
  copy.addEventListener('click', () => copyToClipboard(JSON.stringify(CONFIG, null, 2), 'CONFIG copied as JSON.'));
  tools.append(reset, copy);
  body.appendChild(tools);
}

function renderSpeciesEditor(body, note, entry) {
  note.textContent = entry.file + ' — edit JSON, then Apply. Numeric cfg/breeding apply live; '
    + 'color/model/hitbox need a reload.';
  const ta = document.createElement('textarea');
  ta.className = 'cfg-json';
  ta.spellcheck = false;
  ta.value = JSON.stringify(entry.def, null, 2);
  body.appendChild(ta);

  const tools = document.createElement('div');
  tools.className = 'btn-row';
  const apply = document.createElement('button');
  apply.textContent = 'Apply live';
  apply.addEventListener('click', () => {
    let parsed;
    try { parsed = JSON.parse(ta.value); }
    catch (e) { setConfigStatus('JSON error: ' + e.message); return; }
    entry.def = parsed;
    const id = parsed.id;
    // Live-apply numeric tuning to the objects the engine reads by reference:
    //  - fish/frog: FISH / FROG (their cfg IS the aquatic/terrestrial base)
    //  - any flier (insect, beetle, …): FLIERS[id].cfg, shared with spawned bugs
    // Aquatic/terrestrial CUSTOM species (e.g. koi) ride the archetype's shared
    // objects, so we don't mutate those from here — edit the base species or
    // reload. Color/model/hitbox are built at load and always need a reload.
    const liveCfg = id === 'fish' ? FISH
                  : id === 'frog' ? FROG
                  : (id && FLIERS[id]) ? FLIERS[id].cfg : null;
    const ownsBreeding = ['fish', 'frog', 'insect'].includes(id) || !!(id && FLIERS[id]);
    const touched = [];
    if (liveCfg && parsed.cfg) { deepAssign(liveCfg, parsed.cfg); touched.push('cfg'); }
    if (ownsBreeding && parsed.breeding && BREEDING[id]) { deepAssign(BREEDING[id], parsed.breeding); touched.push('breeding'); }
    setConfigStatus(touched.length
      ? 'Applied ' + touched.join(' + ') + ' live. Color/model/hitbox need a reload.'
      : 'Saved for copy. These fields need a reload to take effect.');
  });
  const copy = document.createElement('button');
  copy.textContent = 'Copy JSON';
  copy.addEventListener('click', () => copyToClipboard(ta.value, entry.file + ' copied.'));
  tools.append(apply, copy);
  body.appendChild(tools);
}

function renderConfigTarget(target) {
  const body = document.getElementById('config-body');
  const note = document.getElementById('config-note');
  if (!body || !note) return;
  body.innerHTML = '';
  setConfigStatus('');
  if (target === 'world') {
    renderWorldEditor(body, note);
  } else {
    const entry = RAW_SPECIES.find(e => e.file === target);
    if (entry) renderSpeciesEditor(body, note, entry);
  }
}

function initConfigEditor() {
  const select = document.getElementById('config-target');
  if (!select) return;
  CONFIG_BASELINE = (typeof structuredClone === 'function')
    ? structuredClone(CONFIG)
    : JSON.parse(JSON.stringify(CONFIG));
  const worldOpt = document.createElement('option');
  worldOpt.value = 'world';
  worldOpt.textContent = 'World (world.js)';
  select.appendChild(worldOpt);
  for (const entry of RAW_SPECIES) {
    const o = document.createElement('option');
    o.value = entry.file;
    o.textContent = (entry.def && (entry.def.name || entry.def.id)) || entry.file;
    select.appendChild(o);
  }
  select.addEventListener('change', () => renderConfigTarget(select.value));
  renderConfigTarget('world');
}

function boot() {
  registerSpecies();           // register custom creatures + plants (defs already loaded up top)
  populatePlantPicker();
  initConfigEditor();          // wire up the live config panel (needs RAW_SPECIES)
  if (SETUP.go) {
    setupEl.classList.add('hidden');
    startSimulation();
  } else {
    wireSetup();
    setupEl.classList.remove('hidden');
    renderer.render(scene, camera); // one composed frame behind the menu
  }
}
boot();
