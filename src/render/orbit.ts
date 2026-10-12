/**
 * A turntable ("orbit") camera for the 3D view.
 *
 * Spherical about a target point: `yaw` spins about the model's +Z axis,
 * `pitch` tilts off the horizon, `distance` dollies. This is the shape every
 * mechanical CAD viewer uses, because a *constrained* turntable never rolls —
 * the up axis stays put, which is what keeps the model from appearing to tip
 * sideways when you drag diagonally.
 *
 * The 3D world is **Z-up**: the 2D drawing already lives on the model XY plane,
 * so extruding along +Z drops a solid straight "up" out of the sketch with no
 * extra transform to reason about.
 *
 * Matrices are column-major, i.e. exactly what `uniformMatrix4fv(loc, false, m)`
 * wants, so nothing is transposed on the way to the GPU.
 */

import { planeNormal, type DocPlane, type Vec2 } from '../core/types';

export interface OrbitState {
  /** Azimuth about +Z, radians. */
  yaw: number;
  /** Elevation above the XY plane, radians. */
  pitch: number;
  /** Eye distance from the target, model units. */
  distance: number;
  /** Look-at point on the drawing plane. */
  target: Vec2;
  /** Vertical field of view, radians. */
  fov: number;
}

export const DEFAULT_ORBIT: OrbitState = {
  yaw: -Math.PI / 4,
  pitch: 0.62,
  distance: 420,
  target: { x: 60, y: 40 },
  fov: (45 * Math.PI) / 180,
};

/** Just shy of the pole: at exactly ±π/2 the up vector is undefined (gimbal). */
const PITCH_LIMIT = 1.5533;

export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

/** Eye position in world space. */
export function eyeOf(o: OrbitState): [number, number, number] {
  const cp = Math.cos(o.pitch);
  return [
    o.target.x + o.distance * cp * Math.cos(o.yaw),
    o.target.y + o.distance * cp * Math.sin(o.yaw),
    o.distance * Math.sin(o.pitch),
  ];
}

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Column-major look-at view matrix. */
export function lookAt(eye: V3, center: V3, up: V3): Float32Array {
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/** Column-major perspective projection. */
export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

/** Column-major `a × b`. */
export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** The view-projection matrix for `o` at the given viewport aspect ratio. */
export function viewProj(o: OrbitState, aspect: number): Float32Array {
  const eye = eyeOf(o);
  const view = lookAt(eye, [o.target.x, o.target.y, 0], [0, 0, 1]);
  const proj = perspective(o.fov, aspect, 1, 20000);
  return mul4(proj, view);
}

/**
 * The eye ray through a screen point given as NDC (`-1..1`, y up).
 *
 * Built from the camera basis rather than by inverting the view-projection
 * matrix: the turntable's basis is right there, and an inverse 4×4 is a whole
 * extra thing to get wrong for the one place a 3D pick is needed.
 */
export function screenRay(
  o: OrbitState,
  aspect: number,
  ndcX: number,
  ndcY: number,
): { origin: V3; dir: V3 } {
  const origin = eyeOf(o);
  const fwd = norm(sub([o.target.x, o.target.y, 0], origin));
  const right = norm(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  const t = Math.tan(o.fov / 2);
  const dir = norm([
    fwd[0] + t * aspect * ndcX * right[0] + t * ndcY * up[0],
    fwd[1] + t * aspect * ndcX * right[1] + t * ndcY * up[1],
    fwd[2] + t * aspect * ndcX * right[2] + t * ndcY * up[2],
  ]);
  return { origin, dir };
}

/**
 * Where the eye ray through the mouse meets a datum plane.
 *
 * `null` when the ray is parallel to the plane or the plane is behind the eye —
 * both mean "no cursor here", which is a state, not an error.
 */
export function hitPlane(
  o: OrbitState,
  aspect: number,
  ndcX: number,
  ndcY: number,
  plane: DocPlane,
): [number, number, number] | null {
  const { origin, dir } = screenRay(o, aspect, ndcX, ndcY);
  const n = planeNormal(plane);
  const denom = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
  if (Math.abs(denom) < 1e-9) return null;
  const t =
    (n[0] * (plane.origin[0] - origin[0]) +
      n[1] * (plane.origin[1] - origin[1]) +
      n[2] * (plane.origin[2] - origin[2])) /
    denom;
  if (!(t > 0)) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

/**
 * The nearest datum plane whose *tile* the eye ray passes through.
 *
 * The tile is the square the 3D view draws as the plane's outline, `half` model
 * units to a side. Hit-testing the drawn tile rather than the infinite plane is
 * the whole point: clicking empty space next to a plane must not select it, or
 * the cursor would promise a target the picture does not show.
 */
export function pickPlane(
  o: OrbitState,
  aspect: number,
  ndcX: number,
  ndcY: number,
  planes: readonly DocPlane[],
  half: number,
): DocPlane | null {
  const { origin, dir } = screenRay(o, aspect, ndcX, ndcY);
  let best: DocPlane | null = null;
  let bestT = Infinity;
  for (const plane of planes) {
    if (!plane.visible) continue;
    const n = planeNormal(plane);
    const denom = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (Math.abs(denom) < 1e-9) continue;
    const t =
      (n[0] * (plane.origin[0] - origin[0]) +
        n[1] * (plane.origin[1] - origin[1]) +
        n[2] * (plane.origin[2] - origin[2])) /
      denom;
    if (!(t > 0) || t >= bestT) continue;
    const px = origin[0] + dir[0] * t - plane.origin[0];
    const py = origin[1] + dir[1] * t - plane.origin[1];
    const pz = origin[2] + dir[2] * t - plane.origin[2];
    // In-plane coordinates of the hit, tested against the drawn tile.
    const u = px * plane.u[0] + py * plane.u[1] + pz * plane.u[2];
    const v = px * plane.v[0] + py * plane.v[1] + pz * plane.v[2];
    if (Math.abs(u) > half || Math.abs(v) > half) continue;
    best = plane;
    bestT = t;
  }
  return best;
}
