#!/usr/bin/env python3
"""Generate a low-poly stylized tree as a binary glTF (.glb).

Hand-authored in the faceted, vertex-coloured style of the Quaternius CC0 models
the project already uses (see assets/models/CREDITS.md). Output is a single
non-indexed, flat-shaded mesh (one material, COLOR_0 vertex colours) so it drops
straight into the instanced vegetation renderer as the 'tree' model.

  python tools/make_tree_glb.py   ->   assets/models/tree_lowpoly.glb

Units: base of the trunk at y=0, ~2.7 tall, ~1 wide (matches the procedural tree
it replaces; the renderer scales each plant by its food-driven radius).
"""
import struct, json, math, os

verts, norms, cols = [], [], []

def add_tri(p0, p1, p2, c0, c1, c2):
    ux, uy, uz = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
    vx, vy, vz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
    nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx          # flat face normal
    L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
    n = (nx/L, ny/L, nz/L)
    for p, c in ((p0, c0), (p1, c1), (p2, c2)):
        verts.append(p); norms.append(n); cols.append(c)

def _norm(v):
    L = math.sqrt(sum(c*c for c in v)) or 1.0
    return (v[0]/L, v[1]/L, v[2]/L)

def icosphere(level, radius, center, color_fn):
    t = (1 + math.sqrt(5)) / 2
    base = [(-1,t,0),(1,t,0),(-1,-t,0),(1,-t,0),(0,-1,t),(0,1,t),
            (0,-1,-t),(0,1,-t),(t,0,-1),(t,0,1),(-t,0,-1),(-t,0,1)]
    base = [_norm(v) for v in base]
    faces = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),
             (11,10,2),(10,7,6),(7,1,8),(3,9,4),(3,4,2),(3,2,6),(3,6,8),
             (3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]
    tris = [(base[i], base[j], base[k]) for i, j, k in faces]
    mid = lambda a, b: _norm(((a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2))
    for _ in range(level):
        nxt = []
        for a, b, c in tris:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nxt += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        tris = nxt
    for a, b, c in tris:
        ps = [(center[0]+v[0]*radius, center[1]+v[1]*radius, center[2]+v[2]*radius) for v in (a, b, c)]
        cs = [color_fn(p) for p in ps]
        add_tri(ps[0], ps[1], ps[2], cs[0], cs[1], cs[2])

def trunk(sides, r_bot, r_top, h, color):
    for i in range(sides):
        a0, a1 = 2*math.pi*i/sides, 2*math.pi*(i+1)/sides
        b0 = (r_bot*math.cos(a0), 0, r_bot*math.sin(a0))
        b1 = (r_bot*math.cos(a1), 0, r_bot*math.sin(a1))
        t0 = (r_top*math.cos(a0), h, r_top*math.sin(a0))
        t1 = (r_top*math.cos(a1), h, r_top*math.sin(a1))
        add_tri(b0, b1, t1, color, color, color)
        add_tri(b0, t1, t0, color, color, color)

BARK = (0.42, 0.28, 0.17)
def canopy_color(p):
    t = max(0.0, min(1.0, (p[1] - 1.2) / 1.6))      # darker at base, brighter crown
    return (0.11 + 0.12*t, 0.34 + 0.34*t, 0.12 + 0.07*t)

# --- compose the tree -------------------------------------------------------
trunk(7, 0.16, 0.11, 1.45, BARK)
icosphere(1, 0.82, ( 0.00, 1.95,  0.00), canopy_color)  # main crown
icosphere(1, 0.58, ( 0.50, 1.70,  0.22), canopy_color)  # side puffs
icosphere(1, 0.54, (-0.46, 1.78, -0.16), canopy_color)
icosphere(1, 0.46, ( 0.06, 2.42, -0.08), canopy_color)  # top tuft

# --- pack GLB ---------------------------------------------------------------
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
    "asset": {"version": "2.0", "generator": "terrarium make_tree_glb.py"},
    "scene": 0, "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0, "name": "LowPolyTree"}],
    "meshes": [{"name": "LowPolyTree", "primitives": [
        {"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "material": 0}]}],
    "materials": [{"name": "foliage", "doubleSided": True,
                   "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                            "metallicFactor": 0.0, "roughnessFactor": 0.9}}],
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
out_path = os.path.join(here, 'assets', 'models', 'tree_lowpoly.glb')
with open(out_path, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))           # glTF, v2, length
    f.write(struct.pack('<II', len(json_b), 0x4E4F534A)); f.write(json_b)  # JSON chunk
    f.write(struct.pack('<II', len(blob), 0x004E4942));  f.write(blob)     # BIN chunk
print(f"wrote {out_path}: {n} verts, {n//3} tris, {total} bytes")
