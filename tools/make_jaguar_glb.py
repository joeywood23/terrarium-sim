#!/usr/bin/env python3
"""Low-poly jaguar GLB (quadruped, baked Walk). -> assets/models/jaguar_lowpoly.glb"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbkit import Mesh, quad_rig, write_glb

GOLD = (0.80, 0.58, 0.28); BELLY = (0.90, 0.80, 0.58); DARK = (0.12, 0.09, 0.07); BLACK = (0.02, 0.02, 0.02)
def lerp(a, b, t): return tuple(a[i] + (b[i]-a[i])*t for i in range(3))
def coat(p):  # paler belly -> richer gold along the back
    return lerp(BELLY, GOLD, max(0.0, min(1.0, (p[1] + 0.35) / 0.7)))

body = Mesh()
body.ellipsoid(2, (0.85, 0.40, 0.40), (0.0, 0.0, 0.0), coat)       # torso
body.ellipsoid(1, (0.34, 0.26, 0.28), (0.92, 0.16, 0.0), coat)     # head
body.ellipsoid(0, (0.14, 0.11, 0.13), (1.18, 0.10, 0.0), GOLD)     # muzzle
for s in (-1, 1):
    body.ellipsoid(0, (0.06, 0.10, 0.05), (0.90, 0.40, s*0.13), DARK)        # ears
    body.ellipsoid(0, (0.045, 0.045, 0.045), (1.10, 0.20, s*0.10), BLACK)    # eyes

def leg(m, x, z):
    m.beam((x, 0.0, z), (x, -0.50, z), 0.085, GOLD)   # leg
    m.beam((x, -0.50, z), (x + 0.05, -0.55, z), 0.10, DARK)  # paw
legsA = Mesh(); leg(legsA, 0.55, 0.22);  leg(legsA, -0.55, -0.22)   # front-left + back-right
legsB = Mesh(); leg(legsB, 0.55, -0.22); leg(legsB, -0.55, 0.22)    # front-right + back-left

tail = Mesh()
tail.beam((0, 0, 0), (-0.35, 0.10, 0), 0.06, GOLD)
tail.beam((-0.35, 0.10, 0), (-0.55, 0.26, 0), 0.045, DARK)

nodes, anim = quad_rig(True, tail_tx=(-0.85, 0.06, 0), sweep=15, bob=0.03, tail_sway=12, period=0.6)
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models', 'jaguar_lowpoly.glb')
write_glb(out, nodes, [body, legsA, legsB, tail], anim, material={"metallicFactor": 0.0, "roughnessFactor": 0.7})
