import assert from "node:assert/strict";
import test from "node:test";
import { P1_LIMITS } from "@hvtp/protocol-types";
import { createReferenceHost, type ReferenceHost } from "./server.js";
import {
  connect, createMessage, cubeInput, helloMessage, joinedPeer, joinMessage, setTransformMessage, type Peer,
} from "./test-support.js";

const MAX = P1_LIMITS.maxMessageBytes;

async function withHost(run: (host: ReferenceHost) => Promise<void>): Promise<void> {
  let tick = 0;
  const host = await createReferenceHost({ databasePath: ":memory:", clock: () => (tick += 20) });
  try { await run(host); } finally { await host.close(); }
}

/** A valid entity.create padded with trailing JSON whitespace to exactly `bytes` UTF-8 bytes. */
function paddedCreate(id: string, entityId: string, bytes: number): Buffer {
  const base = JSON.stringify(createMessage(id, entityId));
  const length = Buffer.byteLength(base);
  assert.ok(bytes >= length);
  return Buffer.from(base + " ".repeat(bytes - length), "utf8");
}

/** Send `payload` as a text message split into the given fragment sizes using real WebSocket continuation frames. */
function sendFragmented(peer: Peer, payload: Buffer, sizes: readonly number[]): void {
  let offset = 0;
  sizes.forEach((size, index) => {
    const end = index === sizes.length - 1 ? payload.length : offset + size;
    peer.socket.send(payload.subarray(offset, end), { binary: false, fin: index === sizes.length - 1 });
    offset = end;
  });
}

test("C21 single-frame text message over maxMessageBytes is not processed and closes with 1009; exactly maxMessageBytes is accepted", () =>
  withHost(async (host) => {
    const peer = await joinedPeer(host);
    peer.socket.send(paddedCreate("req-max", "E-max", MAX), { binary: false });
    assert.equal((await peer.next()).type, "ack");
    assert.equal(host.worldStore.getRealmSeq(), 1);

    peer.socket.send(paddedCreate("req-over", "E-over", MAX + 1), { binary: false });
    assert.equal(await peer.closed, 1009);
    assert.equal(host.worldStore.getEntity("E-over"), null);
    assert.equal(host.worldStore.getRealmSeq(), 1);
    assert.deepEqual(peer.messages, []);
  }));

test("C21 fragmented message whose fragments are individually small but reassemble over maxMessageBytes is rejected unexecuted", () =>
  withHost(async (host) => {
    const peer = await joinedPeer(host);
    const fragment = 100_000;
    assert.ok(fragment < MAX && 3 * fragment > MAX);
    sendFragmented(peer, paddedCreate("req-frag-over", "E-frag-over", 3 * fragment), [fragment, fragment, fragment]);
    assert.equal(await peer.closed, 1009);
    assert.equal(host.worldStore.getEntity("E-frag-over"), null);
    assert.equal(host.worldStore.getRealmSeq(), 0);
    assert.deepEqual(peer.messages, []);
  }));

test("C21 fragmented message within the limit is reassembled and processed normally", () =>
  withHost(async (host) => {
    const peer = await joinedPeer(host);
    sendFragmented(peer, paddedCreate("req-frag-ok", "E-frag-ok", MAX), [90_000, 90_000, 90_000]);
    assert.equal((await peer.next()).type, "ack");
    assert.notEqual(host.worldStore.getEntity("E-frag-ok"), null);
  }));

test("C33 text message with invalid UTF-8 fails the connection with 1007 and later requests are not processed", () =>
  withHost(async (host) => {
    const peer = await connect(host);
    // 0xC3 0x28 is an invalid two-byte sequence, inside otherwise well-formed JSON.
    peer.socket.send(Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), { binary: false });
    peer.send(helloMessage());
    assert.equal(await peer.closed, 1007);
    assert.deepEqual(peer.messages, [], "no application response, and the pipelined hello was never processed");
  }));

test("C33 invalid UTF-8 detected only after reassembly (first fragment ends mid-character) fails with 1007", () =>
  withHost(async (host) => {
    const peer = await connect(host);
    const payload = Buffer.concat([Buffer.from('{"id":"x","note":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')]);
    // The first fragment ends mid-sequence (a truncated 3-byte character); the continuation makes it invalid.
    sendFragmented(peer, payload, [Buffer.from('{"id":"x","note":"').length + 2, 2]);
    assert.equal(await peer.closed, 1007);
    assert.deepEqual(peer.messages, []);
  }));

test("C33 valid multibyte UTF-8 split across WebSocket fragments is evaluated after reassembly", () =>
  withHost(async (host) => {
    const peer = await connect(host);
    const payload = Buffer.from(JSON.stringify(helloMessage("hello-split", "café-\u{1F600}")), "utf8");
    const emoji = payload.indexOf(0xf0); // first byte of the four-byte U+1F600
    sendFragmented(peer, payload, [emoji + 2, 3]); // fragments end inside the code point
    const welcome = await peer.next();
    assert.equal(welcome.type, "session.welcome");
    assert.equal(peer.closeCode, null);
    peer.socket.close();
  }));

test("C33 wire classifications and state-machine preservation: hello stays CONNECTED, join NEGOTIATED, mutation JOINED", () =>
  withHost(async (host) => {
    const peer = await connect(host);
    const expectError = async (text: string, code: string, ref: string | null) => {
      const reply = await peer.request(text);
      assert.equal(reply.type, "error", text);
      assert.equal(reply.body.code, code, text);
      assert.equal(reply.body.ref, ref, text);
    };
    // CONNECTED: every rejected input leaves the session able to hello.
    await expectError("{", "invalid_json", null);
    await expectError("NaN", "invalid_json", null);
    await expectError("Infinity", "invalid_json", null);
    await expectError("[]", "invalid_message", null);
    await expectError("null", "invalid_message", null);
    await expectError('{"id":"a","id":"b","type":"session.hello"}', "invalid_message", null);
    assert.equal((await peer.request(helloMessage())).type, "session.welcome");

    // NEGOTIATED: a rejected join does not advance state.
    await expectError("{", "invalid_json", null);
    await expectError(JSON.stringify({ ...joinMessage("bad-join"), body: { realm: "urn:hvtp:realm:nope", subscription: {} } }), "realm_not_found", "bad-join");
    peer.send(joinMessage("join"));
    assert.equal((await peer.next()).type, "realm.joined");
    while ((await peer.next()).type !== "realm.snapshot.end") { /* drain snapshot */ }

    // JOINED: 1e400 parses to Infinity and reaches component validation with the parsed request id.
    host.worldStore.createEntity(cubeInput("E"));
    const overflow = JSON.stringify(setTransformMessage("req-1e400", "E", 1, 123456)).replace("123456", "1e400");
    assert.ok(overflow.includes("1e400"));
    await expectError(overflow, "invalid_component_state", "req-1e400");
    await expectError("null", "invalid_message", null);
    const ok = await peer.request(setTransformMessage("req-ok", "E", 1, 2));
    assert.equal(ok.type, "ack");
    assert.equal(host.worldStore.getRealmSeq(), 2); // seeded create + req-ok
  }));
