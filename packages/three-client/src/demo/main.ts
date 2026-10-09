import {
  AmbientLight, Color, DirectionalLight, GridHelper, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { P1SharedEntity } from "@hvtp/protocol-types";
import { isPresenceEntity, P1Client, P1OutcomeUncertainError, P1RequestError } from "@hvtp/client-core";
import { P1ThreeView } from "../scene-view.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const urlInput = $<HTMLInputElement>("url");
const statusText = $<HTMLDivElement>("status");
const banner = $<HTMLDivElement>("banner");
const entityList = $<HTMLSelectElement>("entities");
const logBox = $<HTMLDivElement>("log");
const viewport = $<HTMLElement>("viewport");

const params = new URLSearchParams(location.search);
urlInput.value = params.get("host") ?? "ws://127.0.0.1:8787/hvtp";

// --- Three.js presentation -----------------------------------------------------------------------------------
const renderer = new WebGLRenderer({ antialias: true });
renderer.outputColorSpace = SRGBColorSpace; // canonical linear base colors are encoded for display only here
viewport.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color(0x1b1d22);
const camera = new PerspectiveCamera(55, 1, 0.05, 2000);
camera.position.set(5, 5, 9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(4, 8, 6);
scene.add(sun);
scene.add(new GridHelper(20, 20, 0x555555, 0x333333));

const view = new P1ThreeView({ onAssetFailure: (id, reason) => log(`asset fallback for ${id}: ${reason}`) });
scene.add(view.root);

function resize(): void {
  const { clientWidth: width, clientHeight: height } = viewport;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// --- HVTP session ---------------------------------------------------------------------------------------------
let client: P1Client | null = null;
let detach: (() => void) | null = null;
let urlInputChanged = false;
urlInput.oninput = () => { urlInputChanged = true; };

function newClient(url: string): P1Client {
  detach?.();
  const next = new P1Client({ url, participantKind: "human", clientName: "hvtp-three-client", clientVersion: "0.1.0",
    subscription: { spatial: { center: [0, 0, 0], radius: Number($<HTMLInputElement>("radius").value) || 100 } } });
  detach = view.attach(next);
  next.on((event) => {
    if (event.type === "protocol.violation") log(`protocol violation: ${event.error.message}`);
    if (event.type === "host.error") log(`host error: ${event.body.code} ${event.body.message}`);
    if (event.type === "publication.stale") log(`ignored stale ${event.messageType} (${event.subscriptionId})`);
    if (event.type === "closed") log(`closed ${event.code}${event.uncertainRequestIds.length ? `; uncertain: ${event.uncertainRequestIds.join(", ")}` : ""}`);
    render();
    // Asset loads finish after the event that started them; refresh the `[loading]` labels once they settle.
    void view.whenIdle().then(render);
  });
  return next;
}

$("connect").onclick = () => {
  if (client?.phase !== undefined && client.phase !== "disconnected") return;
  if (client === null || urlInputChanged) {
    client = newClient(urlInput.value.trim());
    urlInputChanged = false;
  }
  client.connect().then(() => log("live: fresh snapshot activated"), (error: unknown) => log(`connect failed: ${describe(error)}`));
};
$("disconnect").onclick = () => client?.disconnect();

function selected(): P1SharedEntity | undefined {
  const entity = client?.entities.get(entityList.value);
  return entity === undefined || isPresenceEntity(entity) ? undefined : entity;
}

/** Buttons only send HVTP requests; the scene changes when canonical publications arrive. */
function track(label: string, request: Promise<unknown> | undefined): void {
  if (request === undefined) return;
  log(`${label}: sent`);
  request.then((result) => log(`${label}: ${summary(result)}`), (error: unknown) => log(`${label}: ${describe(error)}`));
}

$("create").onclick = () => track("create", client?.createEntity({
  transform: { position: [Math.round((Math.random() * 6 - 3) * 10) / 10, 0.5, Math.round((Math.random() * 6 - 3) * 10) / 10],
    rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  material: { baseColor: [1, 1, 1, 1] },
}));
$("move").onclick = () => {
  const entity = selected();
  if (entity === undefined) return;
  const [x, y, z] = entity.components["hvtp.transform@1"].state.position;
  track("move", client?.patchComponent(entity.id, "hvtp.transform@1", { position: [x + 1, y, z] }));
};
$("color").onclick = () => {
  const entity = selected();
  if (entity === undefined) return;
  const channel = () => Math.round(Math.random() * 100) / 100;
  track("color", client?.setComponent(entity.id, "hvtp.material@1", { baseColor: [channel(), channel(), channel(), 1] }));
};
$("delete").onclick = () => {
  const entity = selected();
  if (entity !== undefined) track("delete", client?.deleteEntity(entity.id));
};
$("subscribe").onclick = () => {
  const radius = Number($<HTMLInputElement>("radius").value);
  track("subscription", client?.setSubscription({ spatial: { center: [0, 0, 0], radius } }));
};

function render(): void {
  const phase = client?.phase ?? "disconnected";
  banner.textContent = phase === "live" ? `LIVE · ${view.size} rendered` : phase;
  statusText.textContent = [
    `phase: ${phase}`,
    `participant: ${client?.participantId ?? "—"}`,
    `realmEpoch: ${client?.realmEpoch ?? "—"}`,
    `subscription: ${client?.subscriptionId ?? "—"}`,
    `entities in view: ${client?.entities.size ?? 0} (incl. own presence)`,
  ].join("\n");
  const previous = entityList.value;
  entityList.replaceChildren(...[...(client?.entities.values() ?? [])].filter((entity) => !isPresenceEntity(entity)).map((entity) => {
    const option = document.createElement("option");
    option.value = entity.id;
    const shared = entity as P1SharedEntity;
    const [x, , z] = shared.components["hvtp.transform@1"].state.position;
    option.textContent = `${entity.id.slice(0, 24)}… x=${x} z=${z} t#${shared.components["hvtp.transform@1"].revision} m#${shared.components["hvtp.material@1"].revision} [${view.assetStatus(entity.id) ?? "?"}]`;
    return option;
  }));
  entityList.value = previous || (entityList.options[0]?.value ?? "");
}

function log(line: string): void {
  logBox.textContent = `${new Date().toLocaleTimeString()} ${line}\n${logBox.textContent ?? ""}`.slice(0, 8_000);
  render();
}

function summary(result: unknown): string {
  const value = result as { activated?: boolean; body?: { subscriptionId: string }; status?: string; seq?: number; revision?: number };
  if (value.body !== undefined) return `subscription.applied ${value.body.subscriptionId} (activated: ${value.activated})`;
  return `ack ${value.status} seq ${value.seq}${value.revision === undefined ? "" : ` rev ${value.revision}`}`;
}

function describe(error: unknown): string {
  if (error instanceof P1OutcomeUncertainError) return `OUTCOME UNCERTAIN (${error.requestId}); not replayed — check the next snapshot`;
  if (error instanceof P1RequestError) return `error ${error.code}`;
  return error instanceof Error ? error.message : String(error);
}

// Debug/automation handle; not part of any protocol state.
(window as unknown as { hvtpDemo: unknown }).hvtpDemo = { get client() { return client; }, view };
render();
