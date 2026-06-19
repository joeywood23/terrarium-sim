#!/usr/bin/env python3
"""Low-poly capybara GLB (stocky quadruped, baked Walk). -> assets/models/capybara_lowpoly.glb"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbkit import Mesh, quad_rig, write_glb

BROWN = (0.46, 0.33, 0.20); DKBROWN = (0.30, 0.21, 0.12); BLACK = (0.03, 0.03, 0.03)
def lerp(a, b, t): return tuple(a[i] + (b[i]-a[i])*t for i in range(3))
def fur(p):
    return lerp(DKBROWN, BROWN, max(0.0, min(1.0, (p[1] + 0.4) / 0.8)))

body = Mesh()
body.ellipsoid(2, (0.72, 0.46, 0.46), (0.0, 0.0, 0.0), fur)        # barrel torso
body.ellipsoid(1, (0.34, 0.30, 0.30), (0.78, 0.10, 0.0), fur)      # big blocky head
body.ellipsoid(0, (0.16, 0.14, 0.18), (1.04, 0.02, 0.0), DKBROWN)  # blunt muzzle
for s in (-1, 1):
    body.ellipsoid(0, (0.05, 0.06, 0.05), (0.70, 0.34, s*0.16), DKBROWN)     # small ears
    body.ellipsoid(0, (0.04, 0.04, 0.04), (0.98, 0.16, s*0.13), BLACK)       # eyes

def leg(m, x, z):
    m.beam((x, -0.10, z), (x, -0.46, z), 0.10, BROWN)     # short stocky leg
    m.beam((x, -0.46, z), (x, -0.50, z), 0.12, DKBROWN)   # foot
legsA = Mesh(); leg(legsA, 0.42, 0.26);  leg(legsA, -0.42, -0.26)
legsB = Mesh(); leg(legsB, 0.42, -0.26); leg(legsB, -0.42, 0.26)

nodes, anim = quad_rig(False, sweep=11, bob=0.02, period=0.7)      # no real tail; slow amble
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models', 'capybara_lowpoly.glb')
write_glb(out, nodes, [body, legsA, legsB], anim, material={"metallicFactor": 0.0, "roughnessFactor": 0.9})
