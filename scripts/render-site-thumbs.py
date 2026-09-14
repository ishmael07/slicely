"""Render the three phone-stand thumbnails the landing page's hero demo shows in
its model cards (site/img/stand-*.png). The meshes are built here, procedurally,
so nothing on the marketing page is someone else's model. numpy + Pillow only:
    python3 scripts/render-site-thumbs.py site/img"""
import numpy as np
from PIL import Image
import sys, os

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
W, H, SS = 380, 240, 3  # output size, supersample factor

# ---------- mesh helpers ----------
def box(x0, y0, z0, x1, y1, z1):
    v = np.array([[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], float)
    f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
    return v[np.array(f)]

def prism(poly_xz, y0, y1):
    """Extrude a convex polygon in the XZ plane along Y."""
    p = np.array(poly_xz, float); n = len(p)
    tris = []
    a = np.array([[p[0][0], y0, p[0][1]]])
    for i in range(1, n-1):
        tris.append([[p[0][0],y0,p[0][1]],[p[i+1][0],y0,p[i+1][1]],[p[i][0],y0,p[i][1]]])
        tris.append([[p[0][0],y1,p[0][1]],[p[i][0],y1,p[i][1]],[p[i+1][0],y1,p[i+1][1]]])
    for i in range(n):
        a_, b_ = p[i], p[(i+1)%n]
        tris.append([[a_[0],y0,a_[1]],[b_[0],y0,b_[1]],[b_[0],y1,b_[1]]])
        tris.append([[a_[0],y0,a_[1]],[b_[0],y1,b_[1]],[a_[0],y1,a_[1]]])
    return np.array(tris)

def cylinder(cx, cz, r, y0, y1, n=24):
    ang = np.linspace(0, 2*np.pi, n, endpoint=False)
    poly = [(cx + r*np.cos(a), cz + r*np.sin(a)) for a in ang]
    return prism(poly, y0, y1)

def rot_x(tris, deg, about=(0,0,0)):
    t = np.radians(deg); c, s = np.cos(t), np.sin(t)
    R = np.array([[1,0,0],[0,c,-s],[0,s,c]])
    o = np.array(about)
    return (tris - o) @ R.T + o

def fix_winding(tris):
    """Make every triangle's normal point away from the mesh centroid-ish (works for the union of convex parts by checking each part separately upstream)."""
    return tris

# ---------- the three models (mm, y = up, z = toward viewer) ----------
def minimal_stand():
    parts = [box(-32, 0, -30, 32, 6, 30)]                                 # base slab
    back = rot_x(box(-32, 0, 0, 32, 54, 5), -20, (0, 0, 0)) + [0, 6, -28]   # back rest, hinged on its bottom rear edge
    parts.append(back)
    parts.append(box(-32, 6, 16, 32, 15, 22))                             # front lip
    return np.concatenate(parts)

def adjustable_stand():
    parts = [box(-34, 0, -28, 34, 5, 28)]                                 # base
    for sx in (-30, 24):                                                  # two arms
        parts.append(box(sx, 5, -10, sx+6, 34, 4))
    cyl = cylinder(0, 0, 5.5, -32, 32)                                    # pivot along X
    cyl = np.array([[[v[1], v[0], v[2]] for v in tri] for tri in cyl]) + [0, 30, -3]
    parts.append(cyl)
    parts.append(rot_x(box(-26, 0, -2.5, 26, 46, 2.5), -30, (0, 0, 0)) + [0, 30, -3])
    parts.append(box(-34, 5, 16, 34, 12, 22))                             # lip
    return np.concatenate(parts)

def lowpoly_dock():
    # faceted: a hexagonal slab, a faceted angled back, a faceted lip — all convex prisms
    hexa = [(34*np.cos(a), 30*np.sin(a)) for a in np.linspace(np.pi/6, np.pi/6 + 2*np.pi, 6, endpoint=False)]
    base = prism(hexa, 0, 9)
    back_prof = [(-26, 0), (26, 0), (30, 6), (22, 52), (-22, 52), (-30, 6)]
    back = np.array([[[x, y, 0] for (x, y) in tri] for tri in np.zeros((0, 3, 2))])
    back = prism_xy(back_prof, -3, 3)
    back = rot_x(back, -24, (0, 0, 0)) + [0, 9, -18]
    lip = prism_xy([(-24, 0), (24, 0), (20, 9), (-20, 9)], -3, 3) + [0, 9, 17]
    return np.concatenate([base, back, lip])

def prism_xy(poly_xy, z0, z1):
    """Extrude a convex polygon in the XY plane along Z."""
    p = np.array(poly_xy, float); n = len(p); tris = []
    for i in range(1, n-1):
        tris.append([[p[0][0],p[0][1],z0],[p[i][0],p[i][1],z0],[p[i+1][0],p[i+1][1],z0]])
        tris.append([[p[0][0],p[0][1],z1],[p[i+1][0],p[i+1][1],z1],[p[i][0],p[i][1],z1]])
    for i in range(n):
        a_, b_ = p[i], p[(i+1)%n]
        tris.append([[a_[0],a_[1],z0],[b_[0],b_[1],z0],[b_[0],b_[1],z1]])
        tris.append([[a_[0],a_[1],z0],[b_[0],b_[1],z1],[a_[0],a_[1],z1]])
    return np.array(tris)

# ---------- rasteriser ----------
def render(tris, path, cam_yaw=32, cam_pitch=24, colour=(0.86, 0.84, 0.80), dark_tris=None):
    w, h = W*SS, H*SS
    img = np.zeros((h, w, 3), float)
    # background: the card thumb gradient (coral tint → panel)
    yy, xx = np.mgrid[0:h, 0:w]
    t = (xx/w*0.6 + yy/h*0.4)
    bg0 = np.array([0x2a, 0x20, 0x1d])/255  # warm dark
    bg1 = np.array([0x1c, 0x1c, 0x20])/255
    img[:] = bg0*(1-t)[...,None] + bg1*t[...,None]
    zbuf = np.full((h, w), np.inf)

    def transform(v):
        p = np.radians(cam_pitch); y = np.radians(cam_yaw)
        Ry = np.array([[np.cos(y),0,np.sin(y)],[0,1,0],[-np.sin(y),0,np.cos(y)]])
        Rx = np.array([[1,0,0],[0,np.cos(p),-np.sin(p)],[0,np.sin(p),np.cos(p)]])
        return (v - [0, 22, 0]) @ Ry.T @ Rx.T

    light = np.array([-0.4, 0.8, 0.6]); light /= np.linalg.norm(light)
    base_col = np.array(colour)
    rim_col = np.array([1.0, 0.55, 0.32])

    allv = transform(tris.reshape(-1, 3))
    span = max(allv[:,0].max()-allv[:,0].min(), allv[:,1].max()-allv[:,1].min())
    scale = (min(w, h) * 0.72) / span / SS
    cx = (allv[:,0].max()+allv[:,0].min())/2; cy = (allv[:,1].max()+allv[:,1].min())/2

    def draw(tris, colour_mul=1.0):
        for tri in tris:
            v = transform(tri)
            n = np.cross(v[1]-v[0], v[2]-v[0])
            ln = np.linalg.norm(n)
            if ln == 0: continue
            n /= ln
            if n[2] < 0:  # back-facing relative to viewer: flip so both windings render
                n = -n
            diff = max(0.0, float(n @ light))
            rim = max(0.0, 1 - abs(n[2]))**2 * 0.35
            shade = 0.28 + 0.72*diff
            col = (base_col*shade + rim_col*rim) * colour_mul
            # project (orthographic)
            px = (v[:,0]-cx)*scale*SS + w/2
            py = -(v[:,1]-cy)*scale*SS + h/2
            pz = -v[:,2]
            x0, x1 = int(max(0, px.min())), int(min(w-1, np.ceil(px.max())))
            y0, y1 = int(max(0, py.min())), int(min(h-1, np.ceil(py.max())))
            if x1 <= x0 or y1 <= y0: continue
            gx, gy = np.mgrid[x0:x1+1, y0:y1+1]
            gx = gx.T + 0.5; gy = gy.T + 0.5
            (xa,ya),(xb,yb),(xc,yc) = zip(px,py)
            det = (yb-yc)*(xa-xc) + (xc-xb)*(ya-yc)
            if abs(det) < 1e-9: continue
            l1 = ((yb-yc)*(gx-xc) + (xc-xb)*(gy-yc))/det
            l2 = ((yc-ya)*(gx-xc) + (xa-xc)*(gy-yc))/det
            l3 = 1-l1-l2
            inside = (l1>=0)&(l2>=0)&(l3>=0)
            z = l1*pz[0] + l2*pz[1] + l3*pz[2]
            sub = zbuf[y0:y1+1, x0:x1+1]
            upd = inside & (z < sub)
            sub[upd] = z[upd]
            img[y0:y1+1, x0:x1+1][upd] = col

    draw(tris)
    if dark_tris is not None:
        draw(dark_tris, 0.55)
    # soft floor shadow: darken bg under the model's footprint
    out = np.clip(img, 0, 1)
    im = Image.fromarray((out*255).astype(np.uint8)).resize((W, H), Image.LANCZOS)
    im.save(path, optimize=True)
    print(path, os.path.getsize(path))

os.makedirs(OUT, exist_ok=True)
render(minimal_stand(), f"{OUT}/stand-minimal.png", cam_yaw=34, cam_pitch=22, colour=(0.82, 0.82, 0.84))   # grey PLA
render(adjustable_stand(), f"{OUT}/stand-adjustable.png", cam_yaw=-30, cam_pitch=20, colour=(0.93, 0.90, 0.84))  # white
render(lowpoly_dock(), f"{OUT}/stand-lowpoly.png", cam_yaw=28, cam_pitch=26, colour=(1.0, 0.52, 0.30))          # coral
