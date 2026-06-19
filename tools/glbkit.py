#!/usr/bin/env python3
"""Shared toolkit for hand-authoring low-poly, vertex-coloured GLBs.

Faceted (flat-shaded) primitives + a multi-mesh / multi-node / node-animation
GLB writer. Used by the make_<animal>_glb.py generators so each one only has to
describe parts, a node rig, and keyframes.

Convention for the project: +X forward, +Y up, body roughly centred.
"""
import struct, json, math

_PHI = (1 + math.sqrt(5)) / 2
def _n(v):
    L = math.sqrt(sum(c*c for c in v)) or 1.0
    return (v[0]/L, v[1]/L, v[2]/L)
def _cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
_ICO_V = [_n(v) for v in [(-1,_PHI,0),(1,_PHI,0),(-1,-_PHI,0),(1,-_PHI,0),(0,-1,_PHI),(0,1,_PHI),
    (0,-1,-_PHI),(0,1,-_PHI),(_PHI,0,-1),(_PHI,0,1),(-_PHI,0,-1),(-_PHI,0,1)]]
_ICO_F = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),
          (3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]

def quat_axis(axis, deg):
    a = math.radians(deg) / 2.0
    s = math.sin(a)
    return (axis[0]*s, axis[1]*s, axis[2]*s, math.cos(a))
QY = lambda d: quat_axis((0, 1, 0), d)
QZ = lambda d: quat_axis((0, 0, 1), d)
QX = lambda d: quat_axis((1, 0, 0), d)

class Mesh:
    """A flat-shaded, vertex-coloured triangle soup (one glTF mesh/primitive)."""
    def __init__(self):
        self.v, self.nrm, self.col = [], [], []

    def tri(self, p0, p1, p2, c0, c1, c2):
        ux, uy, uz = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
        vx, vy, vz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
        nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
        L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
        n = (nx/L, ny/L, nz/L)
        for p, c in ((p0, c0), (p1, c1), (p2, c2)):
            self.v.append(p); self.nrm.append(n); self.col.append(c)

    def quad(self, a, b, c, d, col):
        self.tri(a, b, c, col, col, col); self.tri(a, c, d, col, col, col)

    def ellipsoid(self, level, scale, center, color):
        cf = color if callable(color) else (lambda p: color)
        tris = [(_ICO_V[i], _ICO_V[j], _ICO_V[k]) for i, j, k in _ICO_F]
        mid = lambda a, b: _n(((a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2))
        for _ in range(level):
            nxt = []
            for a, b, c in tris:
                ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
                nxt += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
            tris = nxt
        for a, b, c in tris:
            ps = [(center[0]+x[0]*scale[0], center[1]+x[1]*scale[1], center[2]+x[2]*scale[2]) for x in (a, b, c)]
            self.tri(ps[0], ps[1], ps[2], cf(ps[0]), cf(ps[1]), cf(ps[2]))

    def beam(self, p0, p1, r, color):
        d = (p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2])
        up = (0, 1, 0) if abs(_n(d)[1]) < 0.9 else (1, 0, 0)
        a = _n(_cross(d, up)); b = _n(_cross(d, a))
        rr = r if isinstance(r, (tuple, list)) else (r, r)
        def corners(p):
            return [(p[0]+(a[0]*sa*rr[0]+b[0]*sb*rr[1]), p[1]+(a[1]*sa*rr[0]+b[1]*sb*rr[1]),
                     p[2]+(a[2]*sa*rr[0]+b[2]*sb*rr[1])) for sa, sb in ((1,1),(-1,1),(-1,-1),(1,-1))]
        c0, c1 = corners(p0), corners(p1)
        for i in range(4):
            j = (i+1) % 4
            self.quad(c0[i], c0[j], c1[j], c1[i], color)
        self.quad(c0[3], c0[2], c0[1], c0[0], color)
        self.quad(c1[0], c1[1], c1[2], c1[3], color)

def quad_rig(has_tail, tail_tx=None, sweep=14.0, bob=0.03, tail_sway=8.0, period=0.6):
    """Standard quadruped rig + 'Walk' clip for meshes [body, legsA, legsB, (tail)].
    Diagonal leg pairs swing fore-aft (about Z) in antiphase, body bobs, tail sways.
    Returns (nodes, anim)."""
    kids = [1, 2, 3] + ([4] if has_tail else [])
    nodes = [
        {"name": "root", "children": kids},
        {"name": "body", "mesh": 0, "translation": [0, 0, 0]},
        {"name": "legsA", "mesh": 1, "rotation": [0, 0, 0, 1]},
        {"name": "legsB", "mesh": 2, "rotation": [0, 0, 0, 1]},
    ]
    if has_tail:
        nodes.append({"name": "tail", "mesh": 3, "translation": list(tail_tx or [0, 0, 0]), "rotation": [0, 0, 0, 1]})
    T = [period*f for f in (0, 0.25, 0.5, 0.75, 1.0)]
    channels = [
        {"node": 2, "path": "rotation", "times": T, "values": [QZ(d) for d in (0, sweep, 0, -sweep, 0)]},
        {"node": 3, "path": "rotation", "times": T, "values": [QZ(d) for d in (0, -sweep, 0, sweep, 0)]},
        {"node": 1, "path": "translation", "times": T, "values": [(0, 0, 0), (0, bob, 0), (0, 0, 0), (0, bob, 0), (0, 0, 0)]},
    ]
    if has_tail:
        channels.append({"node": 4, "path": "rotation", "times": T, "values": [QY(d) for d in (0, tail_sway, 0, -tail_sway, 0)]})
    return nodes, {"name": "Walk", "channels": channels}


def write_glb(path, nodes, meshes, anim=None, material=None):
    """nodes: list of {name, mesh?, translation?, rotation?, children?} (node 0 = root).
       meshes: list of Mesh (indices match node 'mesh').
       anim: {name, channels:[{node, path, times:[..], values:[tuple..], interp?}]}."""
    buf = bytearray(); views = []; accs = []
    def acc(floats, atype, comp=5126, target=34962, mn=None, mx=None):
        data = struct.pack('<%df' % len(floats), *floats)
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data),
                      **({"target": target} if target else {})})
        buf.extend(data)
        sizes = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}
        a = {"bufferView": len(views)-1, "componentType": comp, "count": len(floats)//sizes[atype], "type": atype}
        if mn is not None: a["min"], a["max"] = mn, mx
        accs.append(a); return len(accs)-1

    meshes_json = []
    for m in meshes:
        P = [c for v in m.v for c in v]
        xs = [v[0] for v in m.v]; ys = [v[1] for v in m.v]; zs = [v[2] for v in m.v]
        ap = acc(P, "VEC3", mn=[min(xs), min(ys), min(zs)], mx=[max(xs), max(ys), max(zs)])
        an = acc([c for n in m.nrm for c in n], "VEC3")
        ac = acc([c for col in m.col for c in col], "VEC3")
        meshes_json.append({"primitives": [{"attributes": {"POSITION": ap, "NORMAL": an, "COLOR_0": ac}, "material": 0}]})

    anims_json = []
    if anim:
        samplers, channels = [], []
        for ch in anim["channels"]:
            t = ch["times"]
            ai = acc(t, "SCALAR", target=None, mn=[min(t)], mx=[max(t)])
            atype = "VEC4" if ch["path"] == "rotation" else "VEC3"
            ao = acc([c for tup in ch["values"] for c in tup], atype, target=None)
            samplers.append({"input": ai, "output": ao, "interpolation": ch.get("interp", "LINEAR")})
            channels.append({"sampler": len(samplers)-1, "target": {"node": ch["node"], "path": ch["path"]}})
        anims_json = [{"name": anim.get("name", "Action"), "samplers": samplers, "channels": channels}]

    mat = material or {"metallicFactor": 0.0, "roughnessFactor": 0.85}
    gltf = {
        "asset": {"version": "2.0", "generator": "terrarium glbkit"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": nodes, "meshes": meshes_json,
        "materials": [{"name": "mat", "doubleSided": True, "pbrMetallicRoughness": mat}],
        "buffers": [{"byteLength": len(buf)}], "bufferViews": views, "accessors": accs,
    }
    if anims_json: gltf["animations"] = anims_json
    json_b = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    json_b += b' ' * ((4 - len(json_b) % 4) % 4)
    blob = bytes(buf) + b'\x00' * ((4 - len(buf) % 4) % 4)
    total = 12 + 8 + len(json_b) + 8 + len(blob)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(json_b), 0x4E4F534A)); f.write(json_b)
        f.write(struct.pack('<II', len(blob), 0x004E4942));  f.write(blob)
    tris = sum(len(m.v) for m in meshes) // 3
    print(f"wrote {path}: {tris} tris, {len(nodes)} nodes, anim={'yes' if anim else 'no'}, {total} bytes")
