// ─────────────────────────────────────────────────────────────────────────────
// A small 3D viewer for the model being worked on.
//
// Hand-written on a 2D canvas rather than pulling in a 3D library. At ~4,000
// triangles a painter's-algorithm renderer holds 60fps comfortably, and the
// whole thing is under 200 lines — where three.js would be ~600KB of bundle for
// a panel that shows one static object.
//
// The look is deliberately plain: one soft key light, flat shading, no texture,
// no grid, no gizmos. A faceted solid slowly turning, which reads as a
// considered object rather than a demo of a 3D engine.
// ─────────────────────────────────────────────────────────────────────────────

/** What the server sends: shared vertices in a unit box, plus indices. */
export interface PreviewMeshData {
  positions: number[];
  indices: number[];
  sizeMm: { x: number; y: number; z: number };
  sourceTriangles: number;
  triangles: number;
}

interface Face {
  /** Indices into the rotated vertex buffer. */
  a: number;
  b: number;
  c: number;
  /** View-space depth, for back-to-front painting. */
  depth: number;
  shade: number;
}

/** Direction the key light comes from, in view space. Normalised. */
const LIGHT = { x: -0.35, y: -0.6, z: 0.72 };

export class ModelViewer {
  private readonly ctx: CanvasRenderingContext2D;
  private raf = 0;
  private angle = 0;
  private dragging = false;
  private lastX = 0;
  private tilt = -0.35;
  private mesh?: PreviewMeshData;
  /** Scratch buffer for rotated vertices, reused every frame so a redraw
   *  allocates nothing and the GC stays quiet during the animation. */
  private rotated = new Float32Array(0);
  private faces: Face[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is unavailable");
    this.ctx = ctx;

    // Drag to spin. Pointer events cover mouse and touch in one path.
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.angle += (e.clientX - this.lastX) * 0.01;
      this.lastX = e.clientX;
      this.draw();
    });
    const stop = (e: PointerEvent): void => {
      this.dragging = false;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  /** Load geometry and start turning. */
  setMesh(mesh: PreviewMeshData): void {
    this.mesh = mesh;
    this.rotated = new Float32Array(mesh.positions.length);
    this.faces = new Array(mesh.indices.length / 3);
    for (let i = 0; i < this.faces.length; i++) {
      this.faces[i] = { a: 0, b: 0, c: 0, depth: 0, shade: 0 };
    }
    this.start();
  }

  start(): void {
    if (this.raf || !this.mesh) return;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(64, now - last);
      last = now;
      // Slow enough to look considered, not like a spinning demo.
      if (!this.dragging) this.angle += dt * 0.00035;
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Stop animating. Called when the panel scrolls away or is replaced, so a
   *  long transcript never leaves a dozen viewers burning CPU. */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const mesh = this.mesh;
    if (!mesh) return;

    // Match the backing store to the CSS size so it stays sharp on retina.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (w === 0 || h === 0) return;

    const cosY = Math.cos(this.angle);
    const sinY = Math.sin(this.angle);
    const cosX = Math.cos(this.tilt);
    const sinX = Math.sin(this.tilt);

    // Rotate every vertex once per frame: yaw about Z (the print's up axis),
    // then a fixed tilt, so the model turns like it would on a turntable.
    const p = mesh.positions;
    const r = this.rotated;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      const x1 = x * cosY - y * sinY;
      const y1 = x * sinY + y * cosY;
      r[i] = x1;
      r[i + 1] = y1 * cosX - z * sinX;
      r[i + 2] = y1 * sinX + z * cosX;
    }

    const scale = Math.min(w, h) * 0.78;
    const ox = w / 2;
    const oy = h / 2;

    // Cull back faces and shade the rest by their angle to the light.
    const idx = mesh.indices;
    let count = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;

      const ux = r[b] - r[a];
      const uy = r[b + 1] - r[a + 1];
      const uz = r[b + 2] - r[a + 2];
      const vx = r[c] - r[a];
      const vy = r[c + 1] - r[a + 1];
      const vz = r[c + 2] - r[a + 2];

      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (nz <= 0) continue; // facing away

      const len = Math.hypot(nx, ny, nz) || 1;
      const lambert = (nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) / len;
      const face = this.faces[count++];
      face.a = a;
      face.b = b;
      face.c = c;
      face.depth = r[a + 2] + r[b + 2] + r[c + 2];
      // Ambient floor so faces pointing away are still legible, not black.
      face.shade = 0.28 + 0.72 * Math.max(0, lambert);
    }

    // Painter's algorithm: far to near. Sorting only the visible faces roughly
    // halves the work versus sorting everything.
    const visible = this.faces.slice(0, count).sort((f, g) => f.depth - g.depth);

    for (const f of visible) {
      const t = f.shade;
      // Warm highlight into a cool shadow, matching the app's accent.
      const cr = Math.round(58 + t * 197);
      const cg = Math.round(62 + t * 122);
      const cb = Math.round(78 + t * 51);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.beginPath();
      ctx.moveTo(ox + r[f.a] * scale, oy - r[f.a + 1] * scale);
      ctx.lineTo(ox + r[f.b] * scale, oy - r[f.b + 1] * scale);
      ctx.lineTo(ox + r[f.c] * scale, oy - r[f.c + 1] * scale);
      ctx.closePath();
      // Stroking the same colour closes the hairline seams that appear between
      // adjacent triangles when the canvas antialiases each one separately.
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.stroke();
      ctx.fill();
    }
  }
}
