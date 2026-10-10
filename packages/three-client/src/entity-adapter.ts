import {
  Color, EdgesGeometry, LineBasicMaterial, LineSegments, LinearSRGBColorSpace, OctahedronGeometry, type Material, type Mesh,
  type Object3D,
} from "three";
import type { P1MaterialState, P1TransformState } from "@hvtp/protocol-types";

/**
 * Applies P1 `hvtp.transform@1` to an entity root object (Prototype Profile §3).
 *
 * Three.js composes `Object3D.matrix` as T × R × S from position/quaternion/scale, which is exactly the P1
 * column-vector convention. Both conventions are right-handed with +Y up, and units are metres. The quaternion
 * is copied component-wise in `[x, y, z, w]` order; no Euler conversion is involved. The selected glTF node is a
 * child of this root, so its hierarchy is evaluated first and the HVTP transform wraps the result.
 */
export function applyTransform(root: Object3D, state: P1TransformState): void {
  const [px, py, pz] = state.position;
  const [qx, qy, qz, qw] = state.rotation;
  const [sx, sy, sz] = state.scale;
  root.position.set(px, py, pz);
  root.quaternion.set(qx, qy, qz, qw);
  root.scale.set(sx, sy, sz);
}

/**
 * Applies P1 `hvtp.material@1.baseColor` (linear-light RGBA) to every compatible primitive material
 * (Prototype Profile §3, C18). The RGB factors are stored as-is in linear space, with no sRGB/UI conversion; the
 * renderer's output color space handles display encoding. Alpha drives opacity/transparency. Texture maps are
 * left untouched. Only per-entity material instances may be passed here; canonical state is only read.
 */
export function applyBaseColor(content: Object3D, state: P1MaterialState): void {
  const [r, g, b, a] = state.baseColor;
  content.traverse((child) => {
    for (const material of materialsOf(child)) {
      const colored = material as Material & { color?: unknown };
      if (!(colored.color instanceof Color)) continue;
      colored.color.setRGB(r, g, b, LinearSRGBColorSpace);
      const transparent = a < 1;
      if (material.transparent !== transparent) material.needsUpdate = true;
      material.transparent = transparent;
      material.opacity = a;
    }
  });
}

/**
 * Per-entity instance of a cached fixture template. Geometry stays shared with (and owned by) the template;
 * every material is cloned so one entity's base color can never change another's.
 */
export function instantiateFixture(template: Object3D): { readonly object: Object3D; readonly ownedMaterials: readonly Material[] } {
  const object = template.clone(true);
  const ownedMaterials: Material[] = [];
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.material === undefined) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => { const copy = material.clone(); ownedMaterials.push(copy); return copy; })
      : (() => { const copy = mesh.material.clone(); ownedMaterials.push(copy); return copy; })();
  });
  return { object, ownedMaterials };
}

export const PLACEHOLDER_NAME = "hvtp-p1-asset-placeholder";

/**
 * Local-only presentation fallback for a failed fixture load: a magenta wireframe octahedron that cannot be
 * mistaken for the unit cube. It is generic (never derived from entity IDs) and needs no network access.
 */
export function createPlaceholder(): { readonly object: Object3D; dispose(): void } {
  const source = new OctahedronGeometry(0.5);
  const geometry = new EdgesGeometry(source);
  source.dispose();
  const material = new LineBasicMaterial({ color: 0xff00ff });
  const object = new LineSegments(geometry, material);
  object.name = PLACEHOLDER_NAME;
  object.userData.p1Placeholder = true;
  return { object, dispose: () => { geometry.dispose(); material.dispose(); } };
}

function materialsOf(object: Object3D): readonly Material[] {
  const material = (object as Partial<Mesh>).material;
  if (material === undefined) return [];
  return Array.isArray(material) ? material : [material];
}
