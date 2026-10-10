import assert from "node:assert/strict";
import test from "node:test";
import type { P1SharedEntity } from "@hvtp/protocol-types";
import { deepFreeze } from "@hvtp/client-core";
import { describeEntity, intentSatisfied, transformPoint } from "./index.js";

const envelope = <T>(state: T, revision = 1) => ({ revision, authority: "host", authorityEpoch: 1, consistency: "authoritative", state }) as const;
const entity = deepFreeze<P1SharedEntity>({
  id: "entity:cube",
  components: {
    "hvtp.transform@1": envelope({ position: [1, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, 2),
    "hvtp.renderable@1": envelope({ asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" }, node: "UnitCube", visible: true }),
    "hvtp.material@1": envelope({ baseColor: [0.25, 0.5, 0.75, 1] }, 3),
  },
} as P1SharedEntity);

test("U1: describeEntity keeps canonical envelopes verbatim and derives the asset URL from the session base", () => {
  const description = describeEntity(entity, "https://realm.example/assets/p1/");
  assert.equal(description.components, entity.components);
  assert.deepEqual(description.derived, { assetUrl: "https://realm.example/assets/p1/unit-cube.gltf", visible: true });
  assert.equal(describeEntity(entity, "https://realm.example/deeper/a/b/").derived.assetUrl, "https://realm.example/deeper/a/b/unit-cube.gltf");
  assert.equal(describeEntity(entity, null).derived.assetUrl, null);
  assert.equal(Object.isFrozen(entity), true);
});

test("U2: transformPoint applies scale, then rotation, then translation (C17)", () => {
  const point = transformPoint({ position: [0, 0, 0], rotation: [0, 0, 0.7071067811865475, 0.7071067811865476], scale: [2, 1, 1] }, [0.5, 0.5, 0.5]);
  [-0.5, 1, 0.5].forEach((expected, index) => assert.ok(Math.abs(point[index]! - expected) < 1e-6, `${point}`));
  assert.deepEqual(transformPoint({ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, [1, 1, 1]), [2, 3, 4]);
});

test("U3: intentSatisfied uses exact equality per component and ignores the others", () => {
  assert.equal(intentSatisfied(entity, { kind: "material", baseColor: [0.25, 0.5, 0.75, 1] }), true);
  assert.equal(intentSatisfied(entity, { kind: "material", baseColor: [0.25, 0.5, 0.75, 0.9999] }), false);
  assert.equal(intentSatisfied(entity, { kind: "position", position: [1, 0.5, 0] }), true);
  assert.equal(intentSatisfied(entity, { kind: "position", position: [1, 0.5, 0.0001] }), false);
});
