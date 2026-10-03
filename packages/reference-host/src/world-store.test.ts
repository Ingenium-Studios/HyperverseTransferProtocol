import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type P1MaterialState,
  type P1SharedEntityInput,
  type P1TransformState,
} from "@hvtp/protocol-types";
import { P1StoreError, P1WorldStore } from "./world-store.js";

function cube(
  id: string,
  x: number,
  baseColor: [number, number, number, number] = [1, 1, 1, 1],
): P1SharedEntityInput {
  return {
    id,
    transform: {
      position: [x, 0.5, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    renderable: {
      asset: { uri: "unit-cube.gltf", mediaType: "model/gltf+json" },
      node: "UnitCube",
      visible: true,
    },
    material: { baseColor },
  };
}

test("durable state/revisions/tombstones survive restart while realm seq resets", () => {
  const dir = mkdtempSync(join(tmpdir(), "hvtp-p1-"));
  const dbPath = join(dir, "world.sqlite");

  try {
    const first = new P1WorldStore(dbPath);
    const created = first.createEntity(cube("entity:live", 0));
    assert.equal(created.seq, 1);
    assert.equal(created.entity.components["hvtp.material@1"].revision, 1);

    const material: P1MaterialState = { baseColor: [0.25, 0.5, 0.75, 1] };
    const updated = first.replaceMutableComponent(
      "entity:live",
      "hvtp.material@1",
      material,
      1,
      1,
    );
    assert.equal(updated.seq, 2);
    assert.equal(updated.entity.components["hvtp.material@1"].revision, 2);

    first.createEntity(cube("entity:dead", 10));
    const deleted = first.deleteEntity("entity:dead");
    assert.equal(deleted.seq, 4);
    assert.equal(first.getRealmSeq(), 4);
    first.close();

    const second = new P1WorldStore(dbPath);
    assert.equal(second.getRealmSeq(), 0);

    const recovered = second.getEntity("entity:live");
    assert.ok(recovered);
    assert.equal(recovered.components["hvtp.material@1"].revision, 2);
    assert.deepEqual(recovered.components["hvtp.material@1"].state.baseColor, material.baseColor);

    assert.equal(second.getEntity("entity:dead"), null);
    assert.equal(second.isTombstoned("entity:dead"), true);

    assert.throws(
      () => second.createEntity(cube("entity:dead", 20)),
      (error) => error instanceof P1StoreError && error.code === "entity_exists",
    );

    assert.throws(
      () =>
        second.replaceMutableComponent(
          "entity:live",
          "hvtp.material@1",
          material,
          1,
          1,
        ),
      (error) =>
        error instanceof P1StoreError &&
        error.code === "revision_mismatch" &&
        error.currentRevision === 2,
    );
    assert.equal(second.getRealmSeq(), 0);

    const noOp = second.replaceMutableComponent(
      "entity:live",
      "hvtp.material@1",
      material,
      2,
      1,
    );
    assert.equal(noOp.seq, 1);
    assert.equal(noOp.entity.components["hvtp.material@1"].revision, 3);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot applies P1 spatial and explicit-entity union semantics", () => {
  const store = new P1WorldStore(":memory:");
  try {
    store.createEntity(cube("entity:near", 60));
    store.createEntity(cube("entity:far", 1000));

    const empty = store.snapshot({});
    assert.equal(empty.baseSeq, 2);
    assert.deepEqual(empty.entities, []);

    const spatial = store.snapshot({
      spatial: { center: [0, 0, 0], radius: 100 },
    });
    assert.deepEqual(spatial.entities.map((entity) => entity.id), ["entity:near"]);

    const union = store.snapshot({
      spatial: { center: [0, 0, 0], radius: 100 },
      entities: ["entity:far"],
    });
    assert.deepEqual(union.entities.map((entity) => entity.id), [
      "entity:far",
      "entity:near",
    ]);
  } finally {
    store.close();
  }
});

test("failed mutations roll back without advancing sequence", () => {
  const store = new P1WorldStore(":memory:");
  try {
    store.createEntity(cube("entity:test", 0));
    assert.equal(store.getRealmSeq(), 1);

    const invalidTransform = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [0, 1, 1],
    } as unknown as P1TransformState;

    assert.throws(
      () =>
        store.replaceMutableComponent(
          "entity:test",
          "hvtp.transform@1",
          invalidTransform,
          1,
          1,
        ),
      (error) => error instanceof P1StoreError && error.code === "invalid_component_state",
    );

    assert.equal(store.getRealmSeq(), 1);
    assert.equal(store.getEntity("entity:test")?.components["hvtp.transform@1"].revision, 1);
  } finally {
    store.close();
  }
});

test("fault injection before commit rolls back component replacement and deletion", () => {
  let fail = false;
  const store = new P1WorldStore(":memory:", { beforeCommit: () => { if (fail) throw new Error("injected commit failure"); } });
  try {
    store.createEntity(cube("entity:atomic", 0));
    fail = true;
    assert.throws(
      () => store.replaceMutableComponent("entity:atomic", "hvtp.material@1", { baseColor: [0, 0, 0, 1] }, 1, 1),
      (error) => error instanceof P1StoreError && error.code === "resource_limit",
    );
    assert.equal(store.getRealmSeq(), 1);
    assert.equal(store.getEntity("entity:atomic")?.components["hvtp.material@1"].revision, 1);
    assert.deepEqual(store.getEntity("entity:atomic")?.components["hvtp.material@1"].state.baseColor, [1, 1, 1, 1]);

    assert.throws(
      () => store.deleteEntity("entity:atomic"),
      (error) => error instanceof P1StoreError && error.code === "resource_limit",
    );
    assert.equal(store.getRealmSeq(), 1);
    assert.equal(store.getEntity("entity:atomic")?.id, "entity:atomic");
    assert.equal(store.isTombstoned("entity:atomic"), false);
  } finally {
    store.close();
  }
});
