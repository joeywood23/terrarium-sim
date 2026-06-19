#!/usr/bin/env python3
"""Low-poly tortoise GLB (domed shell, slow Walk). -> assets/models/tortoise_lowpoly.glb"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbkit import Mesh, quad_rig, write_glb

SHELL = (0.40, 0.30, 0.16); SHELL_HI = (0.62, 0.50, 0.26); SKIN = (0.45, 0.46, 0.34); BLACK = (0.03, 0.03, 0.03)
def lerp(a, b, t): return tuple(a[i] + (b[i]-a[i])*t for i in range(3))
def carapace(p):  # darker rim -> lit dome top
    return lerp(SHELL, SHELL_HI, max(0.0, min(1.0, (p[1] - 0.02) / 0.34)))

body = Mesh()
body.ellipsoid(2, (0.55, 0.34, 0.46), (0.0, 0.12, 0.0), carapace)  # domed carapace
body.ellipsoid(1, (0.56, 0.10, 0.47), (0.0, 0.02, 0.0), SHELL)     # plastron rim
body.ellipsoid(1, (0.16, 0.13, 0.15), (0.60, 0.06, 0.0), SKIN)     # head
body.ellipsoid(0, (0.09, 0.09, 0.13), (0.50, 0.04, 0.0), SKIN)     # neck
for s in (-1, 1):
    body.ellipsoid(0, (0.03, 0.03, 0.03), (0.70, 0.10, s*0.07), BLACK)   # eyes
body.beam((-0.50, 0.04, 0.0), (-0.62, 0.0, 0.0), 0.04, SKIN)       # tail stub

def leg(m, x, z):
    m.beam((x, -0.04, z), (x, -0.28, z), 0.10, SKIN)   # stubby column leg
legsA = Mesh(); leg(legsA, 0.34, 0.30);  leg(legsA, -0.34, -0.30)
legsB = Mesh(); leg(legsB, 0.34, -0.30); leg(legsB, -0.34, 0.30)

nodes, anim = quad_rig(False, sweep=7, bob=0.012, period=1.1)      # slow, small shuffle
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models', 'tortoise_lowpoly.glb')
write_glb(out, nodes, [body, legsA, legsB], anim, material={"metallicFactor": 0.0, "roughnessFactor": 0.9})
