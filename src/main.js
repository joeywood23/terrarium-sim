import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
  Object.assign(shader.uniforms, brushUniforms, zoneUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vBrushWorld;')
    .replace('#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvBrushWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>',
      '#include <common>\nvarying vec3 vBrushWorld;\nuniform vec3 uBrushPos;\nuniform float uBrushRadius;\nuniform float uBrushOn;\nuniform sampler2D uZoneTex;')
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      {
        // Egg-laying zone tint (sampled from the painted mask).
        vec2 zUv = vBrushWorld.xz / vec2(${P.width.toFixed(1)}, ${P.depth.toFixed(1)}) + 0.5;
        float zone = texture2D(uZoneTex, zUv).r;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.36, 0.85, 0.55), zone * 0.4);

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

/* ---- Procedural island: value-noise fBm × rounded-rect edge falloff ---- */
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hash2(ix, iz, seed) {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + seed * 0.131) * 43758.5453123;
  return s - Math.floor(s);
}
function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), w = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi, seed),     b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + d * u) * w;
}
function fbm(x, z, seed) {
  let total = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    total += amp * valueNoise(x * freq, z * freq, seed + o * 17.7);
    norm  += amp;
    amp   *= 0.5;
    freq  *= 2.05;
  }
  return total / norm; // [0, 1]
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
  // Rounded-rectangle falloff to 0 at the platform rim. (For an unbounded
  // streaming world this term becomes a per-island mask or drops away.)
  const u = wx / (P.width / 2), v = wz / (P.depth / 2);
  const d = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
  const falloff = 1 - sstep(0.55, 1.0, d);
  const n = fbm(wx * T.featureFreq, wz * T.featureFreq, worldSeed);
  // worldHeight is the ceiling: terrain can't rise above the walls.
  return Math.min(worldHeight, Math.max(0, n * falloff - 0.10) * worldAmp * 1.4);
}

function generateIsland() {
  worldAmp  = parseFloat(document.getElementById('island-amp').value);
  worldSeed = Math.random() * 1000;
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      heights[iz * NX + ix] = terrainHeightAt(-P.width / 2 + ix * dx, -P.depth / 2 + iz * dz);
    }
  }
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
  if (brush.painting) applyBrush(dt);
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
const FISH = CONFIG.fish;
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
  BREEDING[key] = Object.assign({}, CONFIG.breeding._default, CONFIG.breeding[key]);
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

function buildFishDetailed(tint) {
  const L = FISH.length, H = FISH.height, W = FISH.width;
  const g = new THREE.Group();
  const bodyCol = tint || new THREE.Color(0xff3b30);
  // Tinted fish get their own materials (the color gene); untinted falls back
  // to the shared cached material.
  const bodyMat = tint
    ? new THREE.MeshStandardMaterial({ color: bodyCol.clone(), emissive: bodyCol.clone().multiplyScalar(0.22), emissiveIntensity: 0.5, roughness: 0.5 })
    : cmat('fishBody', { color: 0xff3b30, emissive: 0x661111, emissiveIntensity: 0.5, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), bodyMat);
  body.scale.set(L * 0.62, H, W);        // ellipsoid torpedo
  g.add(body);
  const finCol = bodyCol.clone().multiplyScalar(0.78); // fins a shade darker than the body
  const finMat = tint
    ? new THREE.MeshStandardMaterial({ color: finCol, emissive: finCol.clone().multiplyScalar(0.2), emissiveIntensity: 0.4, roughness: 0.6 })
    : cmat('fishFin', { color: 0xd62a20, emissive: 0x550d0d, emissiveIntensity: 0.4, roughness: 0.6 });
  const tail = new THREE.Mesh(new THREE.ConeGeometry(H * 0.9, L * 0.5, 4), finMat);
  tail.rotation.z = Math.PI / 2;          // fan out behind (-X)
  tail.scale.set(1, 1, 0.25);             // flatten into a fin
  tail.position.set(-L * 0.5, 0, 0);
  g.add(tail);
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(H * 0.5, L * 0.28, 3), finMat);
  dorsal.rotation.x = Math.PI;
  dorsal.scale.set(1, 1, 0.18);
  dorsal.position.set(L * 0.02, H * 0.7, 0);
  g.add(dorsal);
  g.add(eyePair(L * 0.28, H * 0.35, W * 0.45, 0.1));
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/* Generic declarative model builder for JSON-defined species. Reads a parts
 * list of primitives — each { shape, pos, rot, scale, color } — so a new
 * species' 3D model is fully data-driven. `color` may be a hex, or the roles
 * "body"/"bodyDark"/"accent" which resolve against the species' base/gene color
 * (so a tinted/genetic species recolors automatically). */
function buildPartsModel(parts, baseColor, tint) {
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
  return g;
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
  g.traverse(o => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
  return g;
}

const DETAILED_BUILDERS = {
  fish: buildFishDetailed,
  frog: buildFrogDetailed,
  insect: () => buildFlierDetailed('insect'),
};

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
    prey: { lists: [birds], reach: pos => waterDepthAt(pos.x, pos.z) >= fishMinDepth },
    use3D: true,
  });

  // --- Steering: yaw + pitch are the only movement controls ---
  const SR = FISH.steerRate;
  let seeking = false;

  if (graze === 'eat') {
    // Hold station: face the food, bob, don't advance.
    st.heading += angDiff(st.grazeHeading, st.heading) * Math.min(1, dt * SR);
    st.pitch += (0 - st.pitch) * Math.min(1, dt * SR);
    p.y += eatBob(st, FISH.height);
    orientFish(a.mesh, st.heading, st.pitch, dt);
    return;
  }

  if (graze === 'move') {
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
let vegCapacity = VEG.cap; // current InstancedMesh capacity; grows on demand (no hard cap)
let vegMesh = new THREE.InstancedMesh(
  new THREE.SphereGeometry(1, 8, 6), // unit sphere, scaled per-instance
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 }),
  vegCapacity
);
vegMesh.count = 0;

/* Grow the plant InstancedMesh to at least `need` instances. The instance
 * buffer is a fixed GPU allocation, so "unlimited plants" means reallocating
 * a larger mesh (doubling) and re-deriving every instance from the plants
 * array. Shared geometry/material carry over; the old buffers are released. */
function growVegMesh(need) {
  let cap = vegCapacity;
  while (cap < need) cap *= 2;
  const next = new THREE.InstancedMesh(vegMesh.geometry, vegMesh.material, cap);
  const old = vegMesh;
  next.count = plants.length;
  next.frustumCulled = old.frustumCulled;
  platformGroup.add(next);
  platformGroup.remove(old);
  vegMesh = next;
  vegCapacity = cap;
  for (let i = 0; i < plants.length; i++) writePlantInstance(i, plants[i]); // re-write into new buffer
  vegMesh.instanceMatrix.needsUpdate = true;
  if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
  old.dispose(); // frees the old instance buffers (not the shared geo/mat)
}
vegMesh.castShadow = true;
vegMesh.frustumCulled = false;
platformGroup.add(vegMesh);

const plants = [];                 // { x, z, age, grown, food, ... }
const vegYoung = new THREE.Color(VEG.colorYoung);
const vegOld   = new THREE.Color(VEG.colorOld);

/* ---- Plant species registry --------------------------------------------
 * Like creatures, plants are data-driven. Each plant species carries its own
 * young->lush color gradient, full size, and habitat rules (where it may
 * germinate and where it may grow). The built-in "plant" reproduces the
 * original green shore flora exactly. JSON entries with behavior "plant" add
 * more — e.g. a sea plant that only germinates and grows underwater. */
const PLANT_SPECIES = {};
const PLANT_SERIES  = []; // chart series (right axis), one per plant species
function registerPlantSpecies(def) {
  PLANT_SPECIES[def.id] = def;
  PLANT_SERIES.push({ key: def.id, label: def.label, color: def.chartColor });
}
registerPlantSpecies({
  id: 'plant', label: 'Plants', chartColor: '#9be36b',
  young: vegYoung, old: vegOld, maxR: VEG.maxRadius, habitat: 'land',
  canGerminate: (x, z) => waterDepthAt(x, z) <= VEG.seedMaxDepth, // land / waterline
  canGrow: () => true,                                            // grows anywhere
});
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

function writePlantInstance(i, pl) {
  // Food level is the plant's lushness: 1/10 = small & light green (stripped),
  // 10/10 = large & dark green (lush). pl.maxR is the plant's fixed full size
  // (a genetic trait set at birth), so the slider never resizes living plants.
  const foodFrac = pl.food / VEG.maxFood;
  const r = VEG.minRadius + (pl.maxR - VEG.minRadius) * foodFrac;
  const y = sampleHeight(pl.x, pl.z) + r; // rest on the surface
  _vegM4.makeScale(r, r, r);
  _vegM4.setPosition(pl.x, y, pl.z);
  vegMesh.setMatrixAt(i, _vegM4);
  _vegColor.copy(pl.sp.young).lerp(pl.sp.old, foodFrac);
  vegMesh.setColorAt(i, _vegColor);
  pl.shownFood = pl.food; // change-detection baseline for vegVisualTick
}

/* The eaten-bush shake: a quick scale-pulse + horizontal sway (spheres ignore
 * rotation, so we squash/stretch and jitter instead). Size still tracks food. */
function writePlantRustle(i, pl) {
  const foodFrac = pl.food / VEG.maxFood;
  const baseR = VEG.minRadius + (pl.maxR - VEG.minRadius) * foodFrac;
  const ph = (pl.rustlePhase || 0) * RUSTLE.rate;
  const pulse = Math.sin(ph) * RUSTLE.squash;
  const sx = baseR * (1 + pulse + RUSTLE.scaleAmp * Math.abs(Math.sin(ph * 0.5)));
  const sz = baseR * (1 - pulse + RUSTLE.scaleAmp * Math.abs(Math.sin(ph * 0.5)));
  const sy = baseR * (1 - 0.5 * pulse);
  const jx = Math.sin(ph * 1.7) * baseR * RUSTLE.swayFrac;
  const jz = Math.cos(ph * 1.3) * baseR * RUSTLE.swayFrac;
  _vegPos.set(pl.x + jx, sampleHeight(pl.x, pl.z) + sy, pl.z + jz);
  _vegQuat.identity();
  _vegScale.set(sx, sy, sz);
  _vegM4.compose(_vegPos, _vegQuat, _vegScale);
  vegMesh.setMatrixAt(i, _vegM4);
  _vegColor.copy(pl.sp.young).lerp(pl.sp.old, foodFrac);
  vegMesh.setColorAt(i, _vegColor);
}

function addPlant(x, z, food = VEG.startFood, sp = PLANT_SPECIES.plant) {
  if (plants.length >= vegCapacity) growVegMesh(plants.length + 1); // expand, never reject
  const i = plants.length;
  const cellKey = vegKey(Math.floor(x / vegCell), Math.floor(z / vegCell));
  // Roll a fixed full size: 60%-100% of this species' max AT BIRTH. This "gene"
  // stays with the plant for life — later slider changes only affect new plants.
  const maxR = Math.max(VEG.minRadius, sp.maxR * (0.6 + Math.random() * 0.4));
  const pl = { x, z, food, idx: i, cellKey, eaten: false, maxR, sp };
  plants.push(pl);
  writePlantInstance(i, pl);
  vegMesh.count = plants.length;
  let arr = vegGrid.get(cellKey);
  if (!arr) vegGrid.set(cellKey, arr = []);
  arr.push(pl);
  return true;
}

/* Swap-remove a plant from the InstancedMesh (e.g. eaten by a grazer). */
function removePlant(pl) {
  if (pl.eaten) return;
  pl.eaten = true;
  const cellArr = vegGrid.get(pl.cellKey);
  if (cellArr) {
    const j = cellArr.indexOf(pl);
    if (j >= 0) cellArr.splice(j, 1);
  }
  const i = pl.idx;
  const last = plants[plants.length - 1];
  plants.pop();
  if (last !== pl) {            // move the last plant into the freed slot
    plants[i] = last;
    last.idx = i;
    writePlantInstance(i, last);
  }
  vegMesh.count = plants.length;
  vegMesh.instanceMatrix.needsUpdate = true;
  if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
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
  vegGrid.clear();
  vegMesh.count = 0;
  vegMesh.instanceMatrix.needsUpdate = true;
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
  const n = fbm(x * G.clumpFreq, z * G.clumpFreq, worldSeed + (water_ ? 137.9 : 71.3));
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

function generateVegetation() {
  clearAllPlants();
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
  vegMesh.instanceMatrix.needsUpdate = true;
  if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
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
    vegMesh.instanceMatrix.needsUpdate = true;
    if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
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
  for (let i = plants.length - 1; i >= 0; i--) {
    const pl = plants[i];
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

/* Visual half: rewrite an instance matrix only when its appearance actually
 * changed — rustling, just settled, or food drifted visibly since the last
 * write (writePlantInstance records pl.shownFood). Regrowth is slow, so this
 * cuts thousands of matrix composes per frame down to a handful. */
function vegVisualTick() {
  let dirty = false;
  for (let i = 0; i < plants.length; i++) {
    const pl = plants[i];
    if (pl.rustle > 0)      { writePlantRustle(i, pl);   dirty = true; }
    else if (pl.settle)     { writePlantInstance(i, pl); pl.settle = false; dirty = true; }
    else if (Math.abs(pl.food - pl.shownFood) > 0.05) { writePlantInstance(i, pl); dirty = true; }
  }
  if (dirty) {
    vegMesh.instanceMatrix.needsUpdate = true;
    if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
  }
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

/* Unified forage controller. `diet` describes what this species eats:
 *   { plant: predicate,                         // grazeable plants (reach test)
 *     prey:    { lists, reach },                 // live creatures it hunts+kills
 *     carrion: { lists } }                       // corpses it scavenges
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
    if ((diet.prey || diet.carrion) && st.forageRetry <= 0) {
      if (diet.prey) {
        const pr = nearestCreature(p.x, p.z, PRED.searchRadius, diet.prey.lists,
          c => !c.st.dead && !c.st.consumed && diet.prey.reach(c.mesh.position));
        if (pr) {
          let d = (pr.mesh.position.x-p.x)**2 + (pr.mesh.position.z-p.z)**2;
          if (diet.use3D) d += (pr.mesh.position.y - p.y) ** 2;
          if (d < candD) { cand = pr; candType = 'prey'; candD = d; }
        }
      }
      if (diet.carrion) {
        const ca = nearestCreature(p.x, p.z, PRED.searchRadius, diet.carrion.lists,
          c => c.st.dead && !c.st.consumed && c.st.meat > 0);
        if (ca) {
          let d = (ca.mesh.position.x-p.x)**2 + (ca.mesh.position.z-p.z)**2;
          if (diet.use3D) d += (ca.mesh.position.y - p.y) ** 2;
          if (d < candD) { cand = ca; candType = 'carrion'; candD = d; }
        }
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
        if (f.ref.food <= 0) removePlant(f.ref); else writePlantInstance(f.ref.idx, f.ref);
        st.forage = null; st.eatTimer = 0;
        vegMesh.instanceMatrix.needsUpdate = true;
        if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
      }
    } else if (f.type === 'prey') {
      if (st.eatTimer >= PRED.catchDuration) { // caught & swallowed whole
        st.hunger = Math.min(st.maxHunger, st.hunger + PRED.preyGain);
        feedGrowth(st, PRED.preyGain);
        consumeAgent(f.ref);
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
const FROG = CONFIG.frog;
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
function frogHop(a) {
  const p = a.mesh.position, st = a.st;
  let h = st.heading + (Math.random() - 0.5) * 1.4;
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

  // Grazing/hunting: hop toward food when hungry; stand still while feeding.
  // Frogs eat land vegetation and snap up any flier (insects, beetles, ...)
  // within reach on land/shallows — every species in the `birds` array.
  const graze = grazeControl(a, dt, {
    plant: plantOnFrogLand,
    prey: { lists: [birds], reach: pos => waterDepthAt(pos.x, pos.z) <= FROG.maxWade },
  });

  // Grounded: idle, then hop (unless standing to feed).
  if (st.grounded && graze !== 'eat') {
    st.hopTimer -= dt;
    if (st.hopTimer <= 0) {
      if (graze === 'move') st.heading = st.grazeHeading; // aim the hop at the plant
      frogHop(a);
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
 * on water, slower than fish). CONFIG.bird remains the shared
 * flier base config that each flier derives from.
 *
 *  insect:  black 1 x 1 x 1 cube, comfortable low to the deck
 * ============================================================ */
function makeFlierSpecies(overrides, matOpts) {
  const cfg = Object.assign({}, CONFIG.bird, overrides);
  return {
    cfg,
    geo: new THREE.BoxGeometry(cfg.length, cfg.height, cfg.width),
    mat: new THREE.MeshStandardMaterial(matOpts),
  };
}
const FLIERS = {
  insect: makeFlierSpecies(
    { length: 1, width: 1, height: 1, altMin: 2 },
    { color: 0x111111, roughness: 0.7 }   // matte black cube
  ),
};

/* ============================================================
 * JSON-DEFINED SPECIES
 *
 * New species are declared in the <script type="application/json"
 * id="species-defs"> block. Each picks a behavior archetype
 * (aquatic | terrestrial | aerial) and rides that archetype's
 * existing physics, diet, and breeding unchanged — so the built-in
 * fish/frog/insect are completely unaffected — while supplying its
 * own name, color (optionally genetic), 3D model, chart color, and
 * egg style from data. Aerial species may also tune flight via cfg,
 * since that archetype is fully parameterized.
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

async function loadCustomSpecies() {
  // Species are individual JSON files listed in config/species/manifest.json.
  let files = [];
  try {
    const mani = await (await fetch('config/species/manifest.json')).json();
    files = Array.isArray(mani.files) ? mani.files : [];
  } catch (e) { console.warn('species manifest load failed —', e.message); return; }
  const defs = [];
  for (const f of files) {
    try { defs.push(await (await fetch('config/species/' + f)).json()); }
    catch (e) { console.warn('species file "' + f + '" failed to load —', e.message); }
  }
  const select = document.getElementById('creature-select');

  for (const d of defs) {
    if (!d || !d.id || SPECIES[d.id] || PLANT_SPECIES[d.id]) continue; // skip malformed / collisions

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
      ? (t) => buildPartsModel(d.model.parts, d.color, d.geneticColor ? t : undefined)
      : (d.model && d.model.builtin && DETAILED_BUILDERS[d.model.builtin])
        ? (t) => DETAILED_BUILDERS[d.model.builtin](d.geneticColor ? t : new THREE.Color(d.color != null ? d.color : 0xffffff))
        : (t) => DETAILED_BUILDERS[archBuiltin](d.geneticColor ? t : new THREE.Color(d.color != null ? d.color : 0xffffff));

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
const DRAGGABLE_IDS = ['readout', 'terrain-panel', 'chart-panel', 'views', 'hint'];
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

function getCreatureEyeHeight(st) {
  if (st.species === 'fish' || SPECIES[st.species]?.list === fishes) return FISH.height;
  if (st.species === 'frog' || SPECIES[st.species]?.list === frogs)  return FROG.height;
  const fl = FLIERS[st.species];
  return fl ? fl.cfg.height : CONFIG.bird.height;
}

function getCreatureSpeed(st) {
  if (st.species === 'fish' || SPECIES[st.species]?.list === fishes) return FISH.speed;
  if (st.species === 'frog' || SPECIES[st.species]?.list === frogs)  return FROG.hopHoriz;
  const fl = FLIERS[st.species];
  if (fl) return st.mode === 'fly' ? fl.cfg.flySpeed : fl.cfg.walkSpeed;
  return CONFIG.bird.walkSpeed;
}

function enterPOV(agent) {
  hideCreatureMenu();
  possessed = agent;
  agent.st.aiSuspended = true;
  povYaw = agent.st.heading;
  povPitch = 0;
  savedCamera = {
    position: camera.position.clone(),
    target: controls.target.clone(),
    maxPolarAngle: controls.maxPolarAngle,
  };
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
  }
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
  povYaw   -= e.movementX * 0.002;
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
    const clampedPitch = Math.max(-FISH.pitchMax, Math.min(FISH.pitchMax, povPitch));
    const cosPitch = Math.cos(clampedPitch);
    const sinPitch = Math.sin(clampedPitch);
    const fwd = new THREE.Vector3(
      -Math.sin(povYaw) * cosPitch,
      sinPitch,
      -Math.cos(povYaw) * cosPitch
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

    st.pitch = clampedPitch;
    st.heading = povYaw;
    mesh.position.set(nx, ny, nz);
    orientFish(mesh, povYaw, st.pitch, dt);
  } else {
    // Ground/air creatures: standard WASD.
    const fwd = new THREE.Vector3(-Math.sin(povYaw), 0, -Math.cos(povYaw));
    const right = new THREE.Vector3(Math.cos(povYaw), 0, -Math.sin(povYaw));
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
    mesh.rotation.y = povYaw;
  }

  // Camera at eye level.
  camera.position.set(nx, ny + eyeH / 2, nz);
  const lookDir = new THREE.Vector3(
    -Math.sin(povYaw) * Math.cos(povPitch),
    Math.sin(povPitch),
    -Math.cos(povYaw) * Math.cos(povPitch)
  );
  camera.lookAt(camera.position.clone().add(lookDir));
}

/* ============================================================
 * READOUT  +  RESIZE
 * ============================================================ */
document.getElementById('r-size').textContent = `${P.width}×${P.depth}`;

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  eggTick(simDt);
  hungerTick(simDt);

  populationTick(simDt, dt); // log every 15 sim-s, live-redraw the chart
  vegVisualTick();           // GPU instance writes: once per frame, changed plants only

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
  renderer.render(scene, camera);
  if (camUnderwater) {
    scene.background = bg0;
    scene.fog.color.copy(bg0);
    scene.fog.near = fogNear;
    scene.fog.far  = fogFar;
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
async function boot() {
  await loadCustomSpecies();   // fetch + register any JSON-defined species
  populatePlantPicker();
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
