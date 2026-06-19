#!/usr/bin/env python3
"""Generate a low-poly stylized beetle as a binary glTF (.glb), WITH a baked
"Scurry" animation.

Faceted, vertex-coloured style. The rig is node-transform animation (no
skinning): the body is one node and the six legs are split into two alternating
tripods (front-left/mid-right/rear-left vs the other three), each a node that
sweeps fore-aft in antiphase, plus a small body bob — the classic insect gait.

  python tools/make_beetle_glb.py   ->   assets/models/beetle_lowpoly.glb

Authored in the engine convention: +X forward, +Y up, body centred, feet ~ -H/2.
"""
import struct, json, math, os

# Three separate mesh buffers (body + the two leg tripods), each its own node.
MESHES = {"body": {"v": [], "n": [], "c": []},
          "legA": {"v": [], "n": [], "c": []},
          "legB": {"v": [], "n": [], "c": []}}
CUR = None

def add_tri(p0, p1, p2, c0, c1, c2):
    ux, uy, uz = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
    vx, vy, vz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
    nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
    L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
    n = (nx/L, ny/L, nz/L)
    for p, c in ((p0, c0), (p1, c1), (p2, c2)):
        CUR["v"].append(p); CUR["n"].append(n); CUR["c"].append(c)

def add_quad(a, b, c, d, col):
    add_tri(a, b, c, col, col, col); add_tri(a, c, d, col, col, col)

def _n(v):
    L = math.sqrt(sum(c*c for c in v)) or 1.0
    return (v[0]/L, v[1]/L, v[2]/L)
def _cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])

_PHI = (1 + math.sqrt(5)) / 2
_ICO_V = [_n(v) for v in [(-1,_PHI,0),(1,_PHI,0),(-1,-_PHI,0),(1,-_PHI,0),(0,-1,_PHI),(0,1,_PHI),
    (0,-1,-_PHI),(0,1,-_PHI),(_PHI,0,-1),(_PHI,0,1),(-_PHI,0,-1),(-_PHI,0,1)]]
_ICO_F = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),
          (3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]

def ellipsoid(level, scale, center, color_fn):
    cf = color_fn if callable(color_fn) else (lambda p: color_fn)
    tris = [(_ICO_V[i], _ICO_V[j], _ICO_V[k]) for i, j, k in _ICO_F]
    mid = lambda a, b: _n(((a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2))
    for _ in range(level):
        nxt = []
        for a, b, c in tris:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nxt += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        tris = nxt
    for a, b, c in tris:
        ps = [(center[0]+v[0]*scale[0], center[1]+v[1]*scale[1], center[2]+v[2]*scale[2]) for v in (a, b, c)]
        add_tri(ps[0], ps[1], ps[2], cf(ps[0]), cf(ps[1]), cf(ps[2]))

def beam(p0, p1, r, color):
    d = (p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2])
    up = (0, 1, 0) if abs(_n(d)[1]) < 0.9 else (1, 0, 0)
    a = _n(_cross(d, up)); b = _n(_cross(d, a))
    def corners(p):
        return [(p[0]+(a[0]*sa+b[0]*sb)*r, p[1]+(a[1]*sa+b[1]*sb)*r, p[2]+(a[2]*sa+b[2]*sb)*r)
                for sa, sb in ((1,1),(-1,1),(-1,-1),(1,-1))]
    c0, c1 = corners(p0), corners(p1)
    for i in range(4):
        j = (i+1) % 4
        add_quad(c0[i], c0[j], c1[j], c1[i], color)
    add_quad(c0[3], c0[2], c0[1], c0[0], color)
    add_quad(c1[0], c1[1], c1[2], c1[3], color)

DARK = (0.07, 0.14, 0.08)
BLACK = (0.02, 0.02, 0.02)
THORAX = (0.10, 0.30, 0.13)
def elytra_color(p):
    t = max(0.0, min(1.0, (p[1] + 0.1) / 0.55))
    return (0.14 + 0.13*t, 0.42 + 0.24*t, 0.18 + 0.09*t)

# --- body (node 1) ---------------------------------------------------------
CUR = MESHES["body"]
ellipsoid(1, (0.60, 0.40, 0.50), (-0.05, 0.08, 0.0), elytra_color)
beam((-0.62, 0.42, 0.0), (0.30, 0.40, 0.0), 0.012, (0.05, 0.10, 0.06))
ellipsoid(1, (0.22, 0.20, 0.34), (0.34, 0.12, 0.0), THORAX)
ellipsoid(0, (0.17, 0.15, 0.21), (0.56, 0.08, 0.0), DARK)
for s in (-1, 1):
    ellipsoid(0, (0.06, 0.06, 0.06), (0.64, 0.13, s*0.14), BLACK)
    beam((0.64, 0.15, s*0.09), (0.93, 0.31, s*0.17), 0.02, DARK)

# --- legs, split into two alternating tripods, built in PIVOT-local space --
PIVOT = (0.0, -0.05, 0.0)   # both tripod nodes sit here and rotate about Y
def leg(mesh, lx, fx, s):
    CUR_local = mesh
    hip = (lx - PIVOT[0], -0.05 - PIVOT[1], s*0.34 - PIVOT[2])
    foot = (fx - PIVOT[0], -0.40 - PIVOT[1], s*0.62 - PIVOT[2])
    global CUR; CUR = CUR_local
    beam(hip, foot, 0.035, DARK)
# Tripod A: front-left, mid-right, rear-left.  Tripod B: the complementary three.
leg(MESHES["legA"],  0.22,  0.30,  1)
leg(MESHES["legA"], -0.05, -0.10, -1)
leg(MESHES["legA"], -0.34, -0.46,  1)
leg(MESHES["legB"],  0.22,  0.30, -1)
leg(MESHES["legB"], -0.05, -0.10,  1)
leg(MESHES["legB"], -0.34, -0.46, -1)

# --- assemble buffer / accessors / bufferViews -----------------------------
buf = bytearray(); bufferViews = []; accessors = []
def add_accessor(floats, atype, comp=5126, target=34962, mn=None, mx=None):
    data = struct.pack('<%df' % len(floats), *floats)
    bufferViews.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data),
                        **({"target": target} if target else {})})
    buf.extend(data)
    comps = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[atype]
    acc = {"bufferView": len(bufferViews)-1, "componentType": comp, "count": len(floats)//comps, "type": atype}
    if mn is not None: acc["min"], acc["max"] = mn, mx
    accessors.append(acc)
    return len(accessors)-1

meshes_json = []
for key in ("body", "legA", "legB"):
    m = MESHES[key]
    P = [c for v in m["v"] for c in v]
    xs = [v[0] for v in m["v"]]; ys = [v[1] for v in m["v"]]; zs = [v[2] for v in m["v"]]
    a_pos = add_accessor(P, "VEC3", mn=[min(xs), min(ys), min(zs)], mx=[max(xs), max(ys), max(zs)])
    a_nor = add_accessor([c for n in m["n"] for c in n], "VEC3")
    a_col = add_accessor([c for col in m["c"] for c in col], "VEC3")
    meshes_json.append({"name": key, "primitives": [
        {"attributes": {"POSITION": a_pos, "NORMAL": a_nor, "COLOR_0": a_col}, "material": 0}]})

# --- "Scurry" animation: antiphase tripod Y-sweep + body bob ---------------
T = [0.0, 0.09, 0.18, 0.27, 0.36]
def quatY(deg):
    a = math.radians(deg) / 2
    return (0.0, math.sin(a), 0.0, math.cos(a))
SWEEP = 16.0
qA = [quatY(d) for d in (0, SWEEP, 0, -SWEEP, 0)]
qB = [quatY(d) for d in (0, -SWEEP, 0, SWEEP, 0)]
bob = [(0, 0.0, 0), (0, 0.03, 0), (0, 0.0, 0), (0, 0.03, 0), (0, 0.0, 0)]
a_time = add_accessor(T, "SCALAR", target=None, mn=[min(T)], mx=[max(T)])
a_qA   = add_accessor([c for q in qA for c in q], "VEC4", target=None)
a_qB   = add_accessor([c for q in qB for c in q], "VEC4", target=None)
a_bob  = add_accessor([c for t in bob for c in t], "VEC3", target=None)

gltf = {
    "asset": {"version": "2.0", "generator": "terrarium make_beetle_glb.py"},
    "scene": 0, "scenes": [{"nodes": [0]}],
    "nodes": [
        {"name": "Beetle", "children": [1, 2, 3]},
        {"name": "body", "mesh": 0, "translation": [0, 0, 0]},
        {"name": "tripodA", "mesh": 1, "translation": list(PIVOT), "rotation": [0, 0, 0, 1]},
        {"name": "tripodB", "mesh": 2, "translation": list(PIVOT), "rotation": [0, 0, 0, 1]},
    ],
    "meshes": meshes_json,
    "materials": [{"name": "beetle", "doubleSided": True,
                   "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                            "metallicFactor": 0.1, "roughnessFactor": 0.5}}],
    "animations": [{"name": "Scurry",
                    "samplers": [
                        {"input": a_time, "output": a_qA, "interpolation": "LINEAR"},
                        {"input": a_time, "output": a_qB, "interpolation": "LINEAR"},
                        {"input": a_time, "output": a_bob, "interpolation": "LINEAR"}],
                    "channels": [
                        {"sampler": 0, "target": {"node": 2, "path": "rotation"}},
                        {"sampler": 1, "target": {"node": 3, "path": "rotation"}},
                        {"sampler": 2, "target": {"node": 1, "path": "translation"}}]}],
    "buffers": [{"byteLength": len(buf)}],
    "bufferViews": bufferViews,
    "accessors": accessors,
}
json_b = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
json_b += b' ' * ((4 - len(json_b) % 4) % 4)
blob = bytes(buf) + b'\x00' * ((4 - len(buf) % 4) % 4)
total = 12 + 8 + len(json_b) + 8 + len(blob)
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_path = os.path.join(here, 'assets', 'models', 'beetle_lowpoly.glb')
with open(out_path, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<II', len(json_b), 0x4E4F534A)); f.write(json_b)
    f.write(struct.pack('<II', len(blob), 0x004E4942));  f.write(blob)
tris = sum(len(MESHES[k]["v"]) for k in MESHES) // 3
print(f"wrote {out_path}: {tris} tris, anim 'Scurry', {total} bytes")
