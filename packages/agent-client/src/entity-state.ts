import type { P1SharedEntity, P1TransformState } from "@hvtp/protocol-types";
import { isPresenceEntity, resolveP1AssetUrl, type P1ViewEntity } from "@hvtp/client-core";

export type P1AgentIntent =
  | { readonly kind: "material"; readonly baseColor: readonly [number, number, number, number] }
  | { readonly kind: "position"; readonly position: readonly [number, number, number] };

export interface P1EntityDescription {
  readonly id: string;
  /** The canonical component envelopes exactly as received (revision, authority, epoch, consistency, state). */
  readonly components: P1SharedEntity["components"];
  /** Only values the agent computed; nothing is inferred from the entity ID (C16). */
  readonly derived: { readonly assetUrl: string | null; readonly visible: boolean };
}

/** The shared entity with this ID, or undefined when absent or when the ID names a presence entity. */
export function sharedEntity(entities: ReadonlyMap<string, P1ViewEntity>, id: string): P1SharedEntity | undefined {
  const entity = entities.get(id);
  return entity === undefined || isPresenceEntity(entity) ? undefined : entity;
}

/** Structured, renderer-free reading of an entity. `assetBaseUri` is the current session's advertised base. */
export function describeEntity(entity: P1SharedEntity, assetBaseUri: string | null): P1EntityDescription {
  const renderable = entity.components["hvtp.renderable@1"].state;
  let assetUrl: string | null = null;
  if (assetBaseUri !== null) {
    try { assetUrl = resolveP1AssetUrl(assetBaseUri, renderable.asset.uri); } catch { assetUrl = null; }
  }
  return { id: entity.id, components: entity.components, derived: { assetUrl, visible: renderable.visible } };
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Exact equality of the intent target with the canonical state; other components are ignored. */
export function intentSatisfied(entity: P1SharedEntity, intent: P1AgentIntent): boolean {
  return intent.kind === "material"
    ? sameNumbers(entity.components["hvtp.material@1"].state.baseColor, intent.baseColor)
    : sameNumbers(entity.components["hvtp.transform@1"].state.position, intent.position);
}

export function intentComponent(intent: P1AgentIntent): "hvtp.material@1" | "hvtp.transform@1" {
  return intent.kind === "material" ? "hvtp.material@1" : "hvtp.transform@1";
}

/** Local-to-world point under T x R x S: scale, then rotate by the unit quaternion, then translate. */
export function transformPoint(state: P1TransformState, local: readonly [number, number, number]): [number, number, number] {
  const [sx, sy, sz] = state.scale;
  const x = local[0] * sx;
  const y = local[1] * sy;
  const z = local[2] * sz;
  const [qx, qy, qz, qw] = state.rotation;
  // v' = v + w*t + q x t, with t = 2 (q x v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty) + state.position[0],
    y + qw * ty + (qz * tx - qx * tz) + state.position[1],
    z + qw * tz + (qx * ty - qy * tx) + state.position[2],
  ];
}
