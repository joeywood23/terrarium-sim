#!/usr/bin/env python3
"""Low-poly scarlet-macaw GLB (bird, baked wing Flap). -> assets/models/macaw_lowpoly.glb"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbkit import Mesh, write_glb, QX

RED = (0.82, 0.16, 0.12); BLUE = (0.13, 0.28, 0.70); YEL = (0.93, 0.78, 0.16)
DARK = (0.10, 0.10, 0.10); WHITE = (0.92, 0.92, 0.92); BLACK = (0.02, 0.02, 0.02)

# Body node (mesh 0): torso, head, beak, tail, eyes.
body = Mesh()
body.ellipsoid(2, (0.40, 0.34, 0.30), (0.0, 0.0, 0.0), RED)        # torso
body.ellipsoid(1, (0.20, 0.20, 0.19), (0.40, 0.22, 0.0), RED)      # head
for s in (-1, 1):
    body.ellipsoid(0, (0.045, 0.05, 0.045), (0.50, 0.28, s*0.10), WHITE)   # eye patch
    body.ellipsoid(0, (0.022, 0.022, 0.022), (0.54, 0.28, s*0.10), BLACK)  # pupil
body.beam((0.54, 0.20, 0.0), (0.74, 0.10, 0.0), (0.10, 0.07), DARK)        # hooked beak
body.beam((0.70, 0.16, 0.0), (0.78, 0.07, 0.0), (0.05, 0.04), DARK)
# long swept tail (red fading to blue) trailing -X
body.beam((-0.34, 0.02, 0.0), (-0.95, 0.06, 0.0), (0.10, 0.05), RED)
body.beam((-0.80, 0.05, 0.0), (-1.05, 0.07, 0.0), (0.06, 0.035), BLUE)

# Wing nodes (mesh 1 = left/+Z, mesh 2 = right/-Z), built around the shoulder pivot.
def wing(side):
    m = Mesh()
    # flattened swept wing: shoulder -> mid -> tip, blue with yellow trailing edge
    m.beam((0, 0, side*0.05), (-0.10, 0.0, side*0.42), (0.16, 0.04), BLUE)
    m.beam((-0.10, 0.0, side*0.42), (-0.22, -0.02, side*0.74), (0.11, 0.03), BLUE)
    m.ellipsoid(0, (0.16, 0.02, 0.10), (-0.12, -0.01, side*0.5), YEL)   # yellow covert
    return m
wingL, wingR = wing(1), wing(-1)

SH = 0.16  # shoulder height
nodes = [
    {"name": "root", "children": [1, 2, 3]},
    {"name": "body", "mesh": 0, "translation": [0, 0, 0]},
    {"name": "wingL", "mesh": 1, "translation": [0.0, SH, 0.14], "rotation": [0, 0, 0, 1]},
    {"name": "wingR", "mesh": 2, "translation": [0.0, SH, -0.14], "rotation": [0, 0, 0, 1]},
]
# Flap: both wings beat up/down together (mirror X-rotation), fast.
T = [0.45*f for f in (0, 0.25, 0.5, 0.75, 1.0)]
seq = (-8, 32, -8, 32, -8)
anim = {"name": "Fly", "channels": [
    {"node": 2, "path": "rotation", "times": T, "values": [QX(d) for d in seq]},
    {"node": 3, "path": "rotation", "times": T, "values": [QX(-d) for d in seq]},
]}
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models', 'macaw_lowpoly.glb')
write_glb(out, nodes, [body, wingL, wingR], anim, material={"metallicFactor": 0.0, "roughnessFactor": 0.6})
