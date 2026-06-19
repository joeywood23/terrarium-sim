#!/usr/bin/env python3
"""Author the rest of the review-list fauna as low-poly GLBs (one per species).

Each builder composes glbkit primitives into a small rig (quadruped / bird / bug
/ fish / primate) with a baked animation, in the engine convention (+X forward,
+Y up, centred, feet ~ -H/2). Run:  python tools/make_fauna.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbkit import Mesh, quad_rig, bird_rig, bug_rig, wag_rig, sway_rig, write_glb

MODELS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'models')
def out(name): return os.path.join(MODELS, name)
def lerp(a, b, t): return tuple(a[i] + (b[i]-a[i])*t for i in range(3))

def legsAB(frontx, backx, sidez, top, foot, r, col, footcol=None):
    """Two diagonal leg-pair meshes for quad_rig: A=front-left+back-right, B=other two."""
    A, B = Mesh(), Mesh()
    fc = footcol or col
    def leg(m, x, z):
        m.beam((x, top, z), (x, foot, z), r, col)
        m.beam((x, foot, z), (x + 0.03, foot - 0.03, z), r * 1.2, fc)
    leg(A, frontx, sidez);  leg(A, backx, -sidez)
    leg(B, frontx, -sidez); leg(B, backx, sidez)
    return A, B

# ---- felines / mammals (quadruped) ----------------------------------------
def ocelot():
    TAN=(0.78,0.62,0.36); PALE=(0.90,0.82,0.62); DK=(0.14,0.10,0.07); BLACK=(0.02,0.02,0.02)
    coat=lambda p: lerp(PALE,TAN,max(0.0,min(1.0,(p[1]+0.3)/0.6)))
    b=Mesh(); b.ellipsoid(2,(0.65,0.32,0.32),(0,0,0),coat); b.ellipsoid(1,(0.26,0.22,0.24),(0.74,0.14,0),coat)
    b.ellipsoid(0,(0.10,0.09,0.10),(0.94,0.08,0),TAN)
    for s in(-1,1):
        b.ellipsoid(0,(0.05,0.09,0.04),(0.72,0.34,s*0.11),DK); b.ellipsoid(0,(0.035,0.035,0.035),(0.90,0.16,s*0.08),BLACK)
    A,B=legsAB(0.42,-0.42,0.18,-0.02,-0.42,0.06,TAN,DK)
    t=Mesh(); t.beam((0,0,0),(-0.3,0.06,0),0.045,TAN); t.beam((-0.3,0.06,0),(-0.46,0.16,0),0.03,DK)
    n,a=quad_rig(True,tail_tx=(-0.65,0.05,0),sweep=16,bob=0.025,tail_sway=12,period=0.55)
    write_glb(out('ocelot_lowpoly.glb'),n,[b,A,B,t],a,{"roughnessFactor":0.7})

def agouti():
    BR=(0.40,0.26,0.14); DK=(0.24,0.15,0.08); BLACK=(0.02,0.02,0.02)
    fur=lambda p: lerp(DK,BR,max(0.0,min(1.0,(p[1]+0.25)/0.5)))
    b=Mesh(); b.ellipsoid(2,(0.42,0.30,0.30),(0,0.02,0),fur); b.ellipsoid(1,(0.20,0.17,0.17),(0.50,0.06,0),fur)
    b.ellipsoid(0,(0.08,0.07,0.08),(0.66,0.0,0),DK)
    for s in(-1,1):
        b.ellipsoid(0,(0.04,0.05,0.03),(0.48,0.24,s*0.10),DK); b.ellipsoid(0,(0.03,0.03,0.03),(0.62,0.10,s*0.09),BLACK)
    A,B=legsAB(0.28,-0.30,0.16,-0.06,-0.40,0.05,BR,DK)
    n,a=quad_rig(False,sweep=13,bob=0.02,period=0.5)
    write_glb(out('agouti_lowpoly.glb'),n,[b,A,B],a,{"roughnessFactor":0.9})

def peccary():
    GREY=(0.28,0.25,0.24); DK=(0.15,0.13,0.12); BLACK=(0.02,0.02,0.02)
    hide=lambda p: lerp(DK,GREY,max(0.0,min(1.0,(p[1]+0.3)/0.6)))
    b=Mesh(); b.ellipsoid(2,(0.58,0.36,0.34),(0,0,0),hide); b.ellipsoid(1,(0.30,0.26,0.24),(0.62,0.02,0),hide)
    b.ellipsoid(0,(0.12,0.10,0.12),(0.90,-0.04,0),DK)
    for s in(-1,1):
        b.ellipsoid(0,(0.05,0.07,0.03),(0.60,0.28,s*0.13),DK); b.ellipsoid(0,(0.03,0.03,0.03),(0.82,0.08,s*0.10),BLACK)
    A,B=legsAB(0.40,-0.40,0.20,-0.04,-0.46,0.07,DK)
    t=Mesh(); t.beam((0,0,0),(-0.12,0.02,0),0.03,DK)
    n,a=quad_rig(True,tail_tx=(-0.58,0.10,0),sweep=12,bob=0.02,tail_sway=6,period=0.55)
    write_glb(out('peccary_lowpoly.glb'),n,[b,A,B,t],a,{"roughnessFactor":0.85})

def sloth():
    GREY=(0.55,0.55,0.42); DK=(0.38,0.38,0.28); FACE=(0.72,0.66,0.50); BLACK=(0.05,0.05,0.05)
    b=Mesh(); b.ellipsoid(2,(0.42,0.40,0.36),(0,0,0),GREY); b.ellipsoid(1,(0.22,0.20,0.20),(0.40,0.16,0),FACE)
    for s in(-1,1): b.ellipsoid(0,(0.05,0.05,0.05),(0.54,0.16,s*0.09),BLACK)
    A,B=legsAB(0.30,-0.28,0.20,0.0,-0.46,0.06,DK)
    n,a=quad_rig(False,sweep=6,bob=0.01,period=1.6)
    write_glb(out('sloth_lowpoly.glb'),n,[b,A,B],a,{"roughnessFactor":1.0})

# ---- reptiles -------------------------------------------------------------
def black_caiman():
    DK=(0.12,0.14,0.12); GREEN=(0.18,0.22,0.16); BLACK=(0.02,0.02,0.02)
    b=Mesh(); b.ellipsoid(2,(0.85,0.22,0.34),(0,0,0),DK)
    b.ellipsoid(1,(0.30,0.16,0.22),(0.95,0.02,0),DK); b.ellipsoid(1,(0.34,0.10,0.13),(1.35,-0.02,0),GREEN)
    for s in(-1,1): b.ellipsoid(0,(0.05,0.06,0.05),(0.92,0.16,s*0.11),BLACK)
    for i in range(5): b.ellipsoid(0,(0.06,0.08,0.05),(0.4-i*0.28,0.18,0),GREEN)
    A,B=legsAB(0.5,-0.5,0.32,-0.10,-0.30,0.06,DK)
    t=Mesh(); t.beam((0,0,0),(-0.7,0.0,0),(0.16,0.10),DK); t.beam((-0.7,0,0),(-1.1,0.04,0),(0.07,0.05),GREEN)
    n,a=quad_rig(True,tail_tx=(-0.85,0.04,0),sweep=8,bob=0.012,tail_sway=16,period=0.8)
    write_glb(out('black_caiman_lowpoly.glb'),n,[b,A,B,t],a,{"roughnessFactor":0.6})

def anole():
    GREEN=(0.36,0.62,0.26); DK=(0.22,0.42,0.16); RED=(0.80,0.20,0.18); BLACK=(0.02,0.02,0.02)
    b=Mesh(); b.ellipsoid(1,(0.40,0.12,0.16),(0,0,0),GREEN); b.ellipsoid(1,(0.16,0.11,0.13),(0.46,0.02,0),GREEN)
    b.ellipsoid(0,(0.07,0.05,0.06),(0.30,-0.06,0),RED)
    for s in(-1,1): b.ellipsoid(0,(0.03,0.03,0.03),(0.52,0.06,s*0.08),BLACK)
    A,B=legsAB(0.26,-0.22,0.16,-0.02,-0.16,0.03,DK)
    t=Mesh(); t.beam((0,0,0),(-0.55,0.0,0),(0.06,0.05),GREEN); t.beam((-0.55,0,0),(-0.8,0.0,0),(0.025,0.02),DK)
    n,a=quad_rig(True,tail_tx=(-0.40,0.0,0),sweep=10,bob=0.008,tail_sway=20,period=0.5)
    write_glb(out('anole_lowpoly.glb'),n,[b,A,B,t],a,{"roughnessFactor":0.5})

def dart_frog():
    BLUE=(0.12,0.40,0.78); BLACK=(0.04,0.04,0.06); YEL=(0.90,0.80,0.10)
    b=Mesh(); b.ellipsoid(2,(0.34,0.24,0.30),(0,0.04,0),BLUE)
    for s in(-1,1):
        b.ellipsoid(0,(0.07,0.07,0.07),(0.22,0.16,s*0.12),BLACK); b.ellipsoid(0,(0.03,0.03,0.03),(0.27,0.17,s*0.12),YEL)
    A,B=legsAB(0.18,-0.20,0.18,-0.06,-0.22,0.05,BLUE,BLACK)
    n,a=quad_rig(False,sweep=8,bob=0.015,period=0.8)
    write_glb(out('dart_frog_lowpoly.glb'),n,[b,A,B],a,{"roughnessFactor":0.5})

# ---- birds / fliers (bird_rig) --------------------------------------------
def harpy_eagle():
    GREY=(0.40,0.42,0.46); WHITE=(0.88,0.88,0.86); DK=(0.16,0.16,0.18); YEL=(0.85,0.70,0.20); BLACK=(0.04,0.04,0.04)
    b=Mesh(); b.ellipsoid(2,(0.42,0.38,0.32),(0,0,0),WHITE); b.ellipsoid(1,(0.20,0.20,0.19),(0.36,0.26,0),GREY)
    for s in(-1,1):
        b.ellipsoid(0,(0.05,0.05,0.045),(0.46,0.30,s*0.09),YEL); b.ellipsoid(0,(0.02,0.02,0.02),(0.50,0.30,s*0.09),BLACK)
        b.ellipsoid(0,(0.04,0.10,0.04),(0.30,0.44,s*0.07),GREY); b.beam((0.0,-0.30,s*0.10),(0.06,-0.42,s*0.10),(0.05,0.04),YEL)
    b.beam((0.50,0.20,0),(0.66,0.10,0),(0.09,0.06),DK); b.beam((-0.36,0.0,0),(-0.78,0.0,0),(0.18,0.05),GREY)
    def wing(side):
        m=Mesh(); m.beam((0,0,side*0.05),(-0.06,0.0,side*0.46),(0.20,0.05),GREY); m.beam((-0.06,0,side*0.46),(-0.16,-0.02,side*0.82),(0.13,0.04),DK); return m
    n,a=bird_rig(shoulder=(0.0,0.18,0.13),period=0.6,flap=(-6,28,-6,28,-6))
    write_glb(out('harpy_eagle_lowpoly.glb'),n,[b,wing(1),wing(-1)],a,{"roughnessFactor":0.7})

def insect_bat():
    DK=(0.18,0.14,0.16); BODY=(0.26,0.20,0.22); BLACK=(0.02,0.02,0.02)
    b=Mesh(); b.ellipsoid(1,(0.16,0.18,0.14),(0,0,0),BODY); b.ellipsoid(1,(0.11,0.11,0.10),(0.14,0.12,0),BODY)
    for s in(-1,1):
        b.ellipsoid(0,(0.04,0.08,0.03),(0.12,0.22,s*0.05),DK); b.ellipsoid(0,(0.018,0.018,0.018),(0.20,0.12,s*0.05),BLACK)
    def wing(side):
        m=Mesh(); m.beam((0,0,side*0.04),(-0.02,0.0,side*0.34),(0.16,0.015),DK); m.ellipsoid(0,(0.16,0.012,0.14),(-0.05,0.0,side*0.22),DK); return m
    n,a=bird_rig(shoulder=(0.0,0.06,0.08),period=0.3,flap=(-10,40,-10,40,-10))
    write_glb(out('insect_bat_lowpoly.glb'),n,[b,wing(1),wing(-1)],a,{"roughnessFactor":0.8})

def butterfly():
    BODY=(0.10,0.09,0.10); BLUE=(0.18,0.34,0.78); ORANGE=(0.92,0.55,0.12); BLACK=(0.03,0.03,0.03)
    b=Mesh(); b.beam((0.16,0,0),(-0.18,0,0),(0.05,0.05),BODY); b.ellipsoid(0,(0.05,0.05,0.05),(0.18,0.02,0),BODY)
    for s in(-1,1): b.beam((0.16,0.04,0),(0.30,0.12,s*0.06),(0.01,0.01),BLACK)
    def wing(side):
        m=Mesh(); m.ellipsoid(0,(0.16,0.01,0.20),(0.04,0.0,side*0.22),BLUE); m.ellipsoid(0,(0.12,0.01,0.14),(-0.14,0.0,side*0.18),ORANGE); return m
    n,a=bird_rig(shoulder=(0.0,0.0,0.02),period=0.5,flap=(-30,55,-30,55,-30))
    write_glb(out('butterfly_lowpoly.glb'),n,[b,wing(1),wing(-1)],a,{"roughnessFactor":0.5})

# ---- fish (wag_rig) -------------------------------------------------------
def piranha():
    SILVER=(0.55,0.58,0.60); DK=(0.30,0.34,0.36); RED=(0.75,0.30,0.20); BLACK=(0.02,0.02,0.02)
    flank=lambda p: lerp(RED,SILVER,max(0.0,min(1.0,(p[1]+0.25)/0.5)))
    b=Mesh(); b.ellipsoid(2,(0.42,0.34,0.16),(0,0,0),flank); b.ellipsoid(1,(0.14,0.16,0.12),(0.40,-0.02,0),flank)
    b.ellipsoid(0,(0.06,0.05,0.05),(0.52,-0.06,0),DK)
    for s in(-1,1): b.ellipsoid(0,(0.035,0.035,0.02),(0.46,0.08,s*0.08),BLACK)
    b.beam((0.0,0.30,0),(-0.1,0.42,0),(0.10,0.02),DK)
    t=Mesh(); t.beam((0,0,0),(-0.22,0.0,0),(0.02,0.02),DK); t.ellipsoid(0,(0.06,0.16,0.02),(-0.24,0.0,0),DK)
    n,a=wag_rig((-0.40,0,0),period=0.5,amp=20,name="Swim")
    write_glb(out('piranha_lowpoly.glb'),n,[b,t],a,{"roughnessFactor":0.4})

# ---- bug (bug_rig) --------------------------------------------------------
def ant():
    BLACK=(0.06,0.05,0.05); DK=(0.12,0.09,0.07); SHEEN=(0.20,0.14,0.10)
    b=Mesh(); b.ellipsoid(1,(0.26,0.20,0.20),(-0.34,0.05,0),SHEEN); b.ellipsoid(0,(0.10,0.10,0.10),(-0.04,0.04,0),DK); b.ellipsoid(1,(0.16,0.15,0.15),(0.20,0.06,0),DK)
    for s in(-1,1):
        b.ellipsoid(0,(0.03,0.03,0.03),(0.30,0.10,s*0.07),BLACK); b.beam((0.30,0.10,s*0.04),(0.50,0.22,s*0.10),0.012,DK); b.beam((0.34,0.06,s*0.05),(0.46,-0.04,s*0.12),0.012,DK)
    A,B=Mesh(),Mesh()
    def leg(m,x,s): m.beam((x,-0.02,s*0.10),(x+(0.04 if x>0 else -0.04),-0.30,s*0.22),0.02,DK)
    leg(A,0.12,1); leg(A,-0.05,-1); leg(A,-0.22,1)
    leg(B,0.12,-1); leg(B,-0.05,1); leg(B,-0.22,-1)
    n,a=bug_rig(period=0.3,sweep=18,pivot=(0,-0.02,0),bob=0.025)
    write_glb(out('ant_lowpoly.glb'),n,[b,A,B],a,{"roughnessFactor":0.4})

# ---- primate (sway_rig) ---------------------------------------------------
def monkey():
    BR=(0.34,0.24,0.16); FACE=(0.78,0.62,0.46); DK=(0.20,0.14,0.09); BLACK=(0.02,0.02,0.02)
    b=Mesh(); b.ellipsoid(2,(0.26,0.34,0.24),(0,0,0),BR); b.ellipsoid(1,(0.20,0.20,0.19),(0.05,0.42,0),BR); b.ellipsoid(0,(0.13,0.12,0.10),(0.16,0.40,0),FACE)
    for s in(-1,1):
        b.ellipsoid(0,(0.05,0.07,0.04),(0.0,0.46,s*0.18),BR); b.ellipsoid(0,(0.025,0.025,0.025),(0.22,0.42,s*0.06),BLACK)
        b.beam((0.0,0.22,s*0.22),(0.10,-0.18,s*0.30),0.05,BR); b.beam((0.0,-0.30,s*0.12),(0.06,-0.62,s*0.16),0.06,BR)
    b.beam((-0.18,-0.10,0),(-0.45,0.05,0),(0.04,0.04),DK); b.beam((-0.45,0.05,0),(-0.55,0.28,0),(0.03,0.03),DK)
    n,a=sway_rig(period=2.0,amp=4,name="Idle")
    write_glb(out('monkey_lowpoly.glb'),n,[b],a,{"roughnessFactor":0.8})

if __name__ == '__main__':
    for fn in (ocelot, agouti, peccary, sloth, black_caiman, anole, dart_frog,
               harpy_eagle, insect_bat, butterfly, piranha, ant, monkey):
        fn()
