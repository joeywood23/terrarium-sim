#!/usr/bin/env python3
"""Generate a low-poly stylized beetle as a binary glTF (.glb).

Hand-authored in the faceted, vertex-coloured style used elsewhere in the
project. Single non-indexed flat-shaded mesh (one material, COLOR_0 vertex
colours), built directly in the engine convention: +X forward, +Y up, centred
on the body so it drops into the per-creature renderer with no rotation fix.

  python tools/make_beetle_glb.py   ->   assets/models/beetle_lowpoly.glb

Sized to the beetle hitbox (L 1.3 x H 0.8 x W 1.1); body bottom ~ -H/2 so the
feet meet the ground when the engine seats it.
"""
import struct, json, math, os

verts, norms, cols = [], [], []

def add_tri(p0, p1, p2, c0, c1, c2):
    ux, uy, uz = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
    vx, vy, vz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
    nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
    L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
    n = (nx/L, ny/L, nz/L)
    for p, c in ((p0, c0), (p1, c1), (p2, c2)):
        verts.append(p); norms.append(n); cols.append(c)

def add_quad(a, b, c, d, col):
    add_tri(a, b, c, col, col, col); add_tri(a, c, d, col, col, col)

def _n(v):
    L = math.sqrt(sum(c*c for c in v)) or 1.0
    return (v[0]/L, v[1]/L, v[2]/L)
def _cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])

_ICO_V = [_n(v) for v in [(-1,(1+math.sqrt(5))/2,0),(1,(1+math.sqrt(5))/2,0),(-1,-(1+math.sqrt(5))/2,0),
    (1,-(1+math.sqrt(5))/2,0),(0,-1,(1+math.sqrt(5))/2),(0,1,(1+math.sqrt(5))/2),(0,-1,-(1+math.sqrt(5))/2),
    (0,1,-(1+math.sqrt(5))/2),((1+math.sqrt(5))/2,0,-1),((1+math.sqrt(5))/2,0,1),(-(1+math.sqrt(5))/2,0,-1),(-(1+math.sqrt(5))/2,0,1)]]
_ICO_F = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),
          (3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]

def ellipsoid(level, scale, center, color_fn):
    """Scaled icosphere (ellipsoid). color_fn(point)->rgb, or an rgb tuple."""
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
    """Square-section beam between two points (legs / antennae)."""
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

# --- palette ---------------------------------------------------------------
DARK = (0.07, 0.14, 0.08)   # head, legs, antennae
BLACK = (0.02, 0.02, 0.02)  # eyes
def elytra_color(p):        # iridescent green, brighter on top
    t = max(0.0, min(1.0, (p[1] + 0.1) / 0.55))
    return (0.14 + 0.13*t, 0.42 + 0.24*t, 0.18 + 0.09*t)
THORAX = (0.10, 0.30, 0.13)

# --- compose the beetle (+X forward, centred) ------------------------------
ellipsoid(1, (0.60, 0.40, 0.50), (-0.05, 0.08, 0.0), elytra_color)   # domed wing-cases
beam((-0.62, 0.42, 0.0), (0.30, 0.40, 0.0), 0.012, (0.05, 0.10, 0.06))  # elytra centre seam
ellipsoid(1, (0.22, 0.20, 0.34), (0.34, 0.12, 0.0), THORAX)          # pronotum / thorax
ellipsoid(0, (0.17, 0.15, 0.21), (0.56, 0.08, 0.0), DARK)            # head
for s in (-1, 1):
    ellipsoid(0, (0.06, 0.06, 0.06), (0.64, 0.13, s*0.14), BLACK)    # eyes
    beam((0.64, 0.15, s*0.09), (0.93, 0.31, s*0.17), 0.02, DARK)     # antennae
    for lx, fx in ((0.22, 0.30), (-0.05, -0.10), (-0.34, -0.46)):    # 3 legs per side
        beam((lx, -0.05, s*0.34), (fx, -0.40, s*0.62), 0.035, DARK)

# --- pack GLB (header + JSON chunk + BIN chunk) ----------------------------
P = [c for v in verts for c in v]
N = [c for n in norms for c in n]
C = [c for col in cols for c in col]
pos_b = struct.pack('<%df' % len(P), *P)
nor_b = struct.pack('<%df' % len(N), *N)
col_b = struct.pack('<%df' % len(C), *C)
blob = pos_b + nor_b + col_b
n = len(verts)
xs, ys, zs = [v[0] for v in verts], [v[1] for v in verts], [v[2] for v in verts]
gltf = {
    "asset": {"version": "2.0", "generator": "terrarium make_beetle_glb.py"},
    "scene": 0, "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0, "name": "LowPolyBeetle"}],
    "meshes": [{"name": "LowPolyBeetle", "primitives": [
        {"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "material": 0}]}],
    "materials": [{"name": "beetle", "doubleSided": True,
                   "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                            "metallicFactor": 0.1, "roughnessFactor": 0.5}}],
    "buffers": [{"byteLength": len(blob)}],
    "bufferViews": [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_b), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_b), "byteLength": len(nor_b), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_b)+len(nor_b), "byteLength": len(col_b), "target": 34962},
    ],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3",
         "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
        {"bufferView": 1, "componentType": 5126, "count": n, "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": n, "type": "VEC3"},
    ],
}
json_b = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
json_b += b' ' * ((4 - len(json_b) % 4) % 4)
blob   += b'\x00' * ((4 - len(blob) % 4) % 4)
total = 12 + 8 + len(json_b) + 8 + len(blob)
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_path = os.path.join(here, 'assets', 'models', 'beetle_lowpoly.glb')
with open(out_path, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<II', len(json_b), 0x4E4F534A)); f.write(json_b)
    f.write(struct.pack('<II', len(blob), 0x004E4942));  f.write(blob)
print(f"wrote {out_path}: {n} verts, {n//3} tris, {total} bytes")
