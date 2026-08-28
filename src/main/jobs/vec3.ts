// Small, dependency-free 3D vector/matrix helpers shared by mesh.ts (geometry
// extraction) and orientation.ts (pose search). Kept separate from both so
// neither file has to duplicate this arithmetic.
//
// Rotations are represented as flat row-major 3x3 matrices: index r*3+c is
// row r, column c. `matVec` applies M to a column vector: v' = M * v.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Returns the zero vector for a (near-)zero-length input rather than NaN —
 *  degenerate (zero-area) triangles show up in real-world meshes and must not
 *  poison downstream sums. */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / len);
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = new Array(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[row * 3 + k] * b[k * 3 + col];
      r[row * 3 + col] = s;
    }
  }
  return r as unknown as Mat3;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function matRotX(deg: number): Mat3 {
  const c = Math.cos(degToRad(deg));
  const s = Math.sin(degToRad(deg));
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function matRotY(deg: number): Mat3 {
  const c = Math.cos(degToRad(deg));
  const s = Math.sin(degToRad(deg));
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function matRotZ(deg: number): Mat3 {
  const c = Math.cos(degToRad(deg));
  const s = Math.sin(degToRad(deg));
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Build the rotation M = Rz(rzDeg) * Ry(ryDeg) * Rx(rxDeg) — apply Rx first,
 *  then Ry, then Rz, to a vector. This is the convention `eulerXYZFromMatrix`
 *  decodes, so the two must always be used as a pair. */
export function eulerToMatrix(rxDeg: number, ryDeg: number, rzDeg: number): Mat3 {
  return matMul(matRotZ(rzDeg), matMul(matRotY(ryDeg), matRotX(rxDeg)));
}

/**
 * Recover (rxDeg, ryDeg, rzDeg) from a matrix built by `eulerToMatrix`, i.e.
 * M = Rz*Ry*Rx. Standard closed-form extraction (see e.g. any robotics text
 * on "XYZ fixed-angle" / "ZYX Euler" decomposition — the two names describe
 * the same composition order from opposite ends).
 *
 * Degrades gracefully at gimbal lock (|m[6]| ~= 1, i.e. ryDeg ~= +/-90): x is
 * pinned to 0 and z absorbs the combined spin. That is harmless here because
 * a +/-90 deg pitch candidate only ever comes from a flat-face-down rotation,
 * where the leftover spin about the now-vertical axis doesn't change the pose
 * we evaluate (footprint/overhang/bed-contact are all spin-about-Z invariant
 * for a single rigid rotation applied once).
 */
export function eulerXYZFromMatrix(m: Mat3): { x: number; y: number; z: number } {
  const m20 = m[6];
  const clamped = Math.min(1, Math.max(-1, -m20));
  const ry = Math.asin(clamped);
  let rx: number;
  let rz: number;
  if (Math.abs(m20) > 0.999999) {
    // Gimbal lock: rx and rz aren't individually observable — fold all the
    // remaining rotation into rz.
    rx = 0;
    rz = Math.atan2(-m[1], m[4]);
  } else {
    rx = Math.atan2(m[7], m[8]);
    rz = Math.atan2(m[3], m[0]);
  }
  const toDeg = (r: number) => (r * 180) / Math.PI;
  return { x: toDeg(rx), y: toDeg(ry), z: toDeg(rz) };
}

/**
 * Rotation matrix mapping unit vector `from` onto unit vector `to`, via
 * Rodrigues' rotation formula. Used to point a chosen flat face's normal
 * straight down (`to` = (0,0,-1)).
 */
export function matFromToRotation(from: Vec3, to: Vec3): Mat3 {
  const f = normalize(from);
  const t = normalize(to);
  const c = Math.max(-1, Math.min(1, dot(f, t)));
  if (c > 0.9999999) return IDENTITY; // already aligned
  if (c < -0.9999999) {
    // Opposite vectors: any axis perpendicular to `f` gives a valid 180 deg
    // flip. Pick the coordinate axis least aligned with f for numerical
    // stability, then rotate 180 deg about it.
    const ax = Math.abs(f.x) < Math.abs(f.y) ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const axis = normalize(cross(f, ax));
    return matFromAxisAngle(axis, Math.PI);
  }
  const axis = cross(f, t); // not yet normalized; length = sin(angle)
  const s = length(axis);
  const angle = Math.atan2(s, c);
  return matFromAxisAngle(normalize(axis), angle);
}

function matFromAxisAngle(axis: Vec3, angleRad: number): Mat3 {
  const { x, y, z } = axis;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}
