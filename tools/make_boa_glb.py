#!/usr/bin/env python3
"""Low-poly boa GLB (segmented snake, baked Slither). -> assets/models/boa_lowpoly.glb

A chain of parented segment nodes (head at +X, body trailing -X). Each segment
rotates about Y with a per-segment phase offset, so a lateral wave travels down
the body. Bind pose is a straight snake.
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbkit import Mesh, write_glb, QY

GREEN = (0.32, 0.44, 0.22); DKGREEN = (0.20, 0.30, 0.14); BLACK = (0.02, 0.02, 0.02)
def lerp(a, b, t): return tuple(a[i] + (b[i]-a[i])*t for i in range(3))

NSEG = 7
SEG = 0.34
meshes = []
for i in range(NSEG):
    m = Mesh()
    r = 0.20 * (1.0 - 0.78 * (i / (NSEG - 1)))            # taper head -> tail
    col = lerp(GREEN, DKGREEN, i / (NSEG - 1))
    # body segment spans local x in [-SEG, 0] (origin = front joint of this segment)
    m.ellipsoid(2, (SEG * 0.62, r, r * 1.05), (-SEG * 0.5, 0.0, 0.0), col)
    if i == 0:                                            # head bulge + snout + eyes
        m.ellipsoid(2, (0.20, 0.15, 0.17), (0.10, 0.01, 0.0), GREEN)
        m.ellipsoid(0, (0.07, 0.05, 0.07), (0.26, 0.0, 0.0), DKGREEN)
        for s in (-1, 1):
            m.ellipsoid(0, (0.028, 0.028, 0.028), (0.20, 0.06, s*0.08), BLACK)
    meshes.append(m)

# Parented chain: root -> seg0 -> seg1 -> ... (node index = i+1).
nodes = [{"name": "root", "children": [1]}]
for i in range(NSEG):
    node = {"name": f"seg{i}", "mesh": i, "rotation": [0, 0, 0, 1],
            "translation": [0, 0, 0] if i == 0 else [-SEG, 0, 0]}
    if i < NSEG - 1:
        node["children"] = [i + 2]
    nodes.append(node)

# Slither: traveling lateral (Y) wave; last key == first so it loops cleanly.
K, PERIOD, AMP, PHASE = 9, 1.2, 13.0, 0.95
T = [PERIOD * k / (K - 1) for k in range(K)]
channels = []
for i in range(NSEG):
    vals = [QY(AMP * math.sin(2 * math.pi * (k / (K - 1)) + i * PHASE)) for k in range(K)]
    channels.append({"node": i + 1, "path": "rotation", "times": T, "values": vals})
anim = {"name": "Slither", "channels": channels}

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models', 'boa_lowpoly.glb')
write_glb(out, nodes, meshes, anim, material={"metallicFactor": 0.05, "roughnessFactor": 0.55})
