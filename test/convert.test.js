import test from "node:test";
import assert from "node:assert/strict";
import { getMessage } from "../server/registry.js";
import {
  fillMessage,
  messageToJson,
  presenceJson,
  FormError,
  toBinary,
  fromBinary,
} from "../server/convert.js";

const CollectRequest = getMessage("demo.collector.CollectRequest");

test("explicit presence keeps unset and set-to-default apart", () => {
  const unset = fillMessage(CollectRequest, {});
  const zero = fillMessage(CollectRequest, {
    explicit_count: { set: true, value: "0" },
    explicit_note: { set: true, value: "" },
    explicit_flavor: { set: false },
  });

  // The unset message has no explicit_count value at all.
  assert.equal(presenceJson(CollectRequest, unset).explicit_count.set, false);
  assert.equal("explicit_count" in messageToJson(CollectRequest, unset), false);

  // Set-to-default is present and encoded.
  assert.equal(presenceJson(CollectRequest, zero).explicit_count.set, true);
  assert.equal(messageToJson(CollectRequest, zero).explicit_count, 0);
  assert.equal(messageToJson(CollectRequest, zero).explicit_note, "");
  assert.equal(
    toBinary(CollectRequest, zero).length > toBinary(CollectRequest, unset).length,
    true,
  );

  // Round-tripping the bytes preserves the distinction.
  const decoded = fromBinary(CollectRequest, toBinary(CollectRequest, zero));
  assert.equal(presenceJson(CollectRequest, decoded).explicit_count.set, true);
});

test("implicit presence cannot express set vs unset and is reported honestly", () => {
  const message = fillMessage(CollectRequest, { implicit_count: 0 });
  const presence = presenceJson(CollectRequest, message).implicit_count;
  assert.equal(presence.kind, "implicit");
  assert.equal(presence.indistinguishable, true);
  // A default value encodes to the same bytes as an omitted field.
  assert.deepEqual(
    Array.from(toBinary(CollectRequest, fillMessage(CollectRequest, { implicit_count: 0 }))),
    Array.from(toBinary(CollectRequest, fillMessage(CollectRequest, {}))),
  );
  assert.throws(
    () => fillMessage(CollectRequest, { implicit_count: { set: true, value: 0 } }),
    (error) => error instanceof FormError && /cannot distinguish/.test(error.message),
  );
});

test("64-bit integers survive without floating-point rounding", () => {
  const json = {
    big_signed: "-9223372036854775808",
    big_unsigned: "18446744073709551615",
    big_fixed: "9007199254740993",
    big_zigzag: "9223372036854775807",
    big_list: ["9007199254740993", "-9007199254740993"],
    by_epoch: { "9223372036854775807": "far" },
  };
  const message = fillMessage(CollectRequest, { ...json });
  const decoded = fromBinary(CollectRequest, toBinary(CollectRequest, message));
  const out = messageToJson(CollectRequest, decoded);

  assert.equal(out.big_signed, "-9223372036854775808");
  assert.equal(out.big_unsigned, "18446744073709551615");
  assert.equal(out.big_fixed, "9007199254740993");
  assert.equal(out.big_zigzag, "9223372036854775807");
  assert.deepEqual(out.big_list, ["9007199254740993", "-9007199254740993"]);
  assert.equal(out.by_epoch["9223372036854775807"], "far");

  assert.throws(
    () => fillMessage(CollectRequest, { big_signed: 9007199254740993 }),
    /decimal strings/,
  );
  assert.throws(
    () => fillMessage(CollectRequest, { big_unsigned: "-1" }),
    /cannot be negative/,
  );
  assert.throws(
    () => fillMessage(CollectRequest, { big_signed: "9223372036854775808" }),
    /out of range/,
  );
});

test("bytes accept explicit encodings and are reported as base64", () => {
  const hex = fillMessage(CollectRequest, { payload: { encoding: "hex", value: "00ff10" } });
  assert.equal(messageToJson(CollectRequest, hex).payload, "AP8Q");

  const text = fillMessage(CollectRequest, { payload: { encoding: "utf8", value: "hé" } });
  assert.equal(messageToJson(CollectRequest, text).payload, "aMOp");

  assert.throws(
    () => fillMessage(CollectRequest, { payload: { encoding: "hex", value: "0" } }),
    /not valid hex/,
  );
  assert.throws(
    () => fillMessage(CollectRequest, { payload: { encoding: "rot13", value: "x" } }),
    /unsupported bytes encoding/,
  );

  // Repeated bytes keep each element's encoding.
  const chunks = fillMessage(CollectRequest, {
    chunks: [{ encoding: "hex", value: "00" }, { encoding: "base64", value: "AQ==" }],
  });
  assert.deepEqual(messageToJson(CollectRequest, chunks).chunks, ["AA==", "AQ=="]);
});

test("only one oneof member may be set", () => {
  assert.throws(
    () => fillMessage(CollectRequest, { card_token: "x", iban: "y" }),
    /only one member may be set/,
  );
  const cash = fillMessage(CollectRequest, {
    cash: { set: true, value: { amount_cents: "500", currency: "EUR" } },
  });
  const presence = presenceJson(CollectRequest, cash);
  assert.equal(presence.cash.set, true);
  assert.equal(presence.card_token.set, false);
  assert.equal(messageToJson(CollectRequest, cash).cash.amount_cents, "500");
});

test("repeated and map fields are plain collections without presence wrappers", () => {
  const empty = fillMessage(CollectRequest, { pets: [], counters: {} });
  const out = messageToJson(CollectRequest, empty);
  assert.deepEqual(out.pets, []);
  assert.deepEqual(out.counters, {});
  // The wire cannot tell absent from empty, so the presence report says the
  // same for both.
  assert.deepEqual(
    presenceJson(CollectRequest, fillMessage(CollectRequest, {})).pets,
    presenceJson(CollectRequest, empty).pets,
  );
  assert.deepEqual(
    Array.from(toBinary(CollectRequest, fillMessage(CollectRequest, {}))),
    Array.from(toBinary(CollectRequest, empty)),
  );

  // Nested messages in maps and lists are supported.
  const nested = fillMessage(CollectRequest, {
    drops: { north: { street: "1", city: "A" } },
    pets: [{ name: "Milo", favorite_flavor: "VANILLA" }],
    waypoints: [{ city: "B" }],
  });
  const json = messageToJson(CollectRequest, nested);
  assert.equal(json.drops.north.city, "A");
  assert.equal(json.pets[0].favorite_flavor, "VANILLA");
  assert.equal(json.waypoints[0].city, "B");
});

test("map keys are validated for their declared key type", () => {
  assert.throws(
    () => fillMessage(CollectRequest, { by_epoch: { "not-a-number": "x" } }),
    /decimal integer/,
  );
  // counters is map<string,int32>: every key is a valid string key.
  const counters = fillMessage(CollectRequest, { counters: { "1.5": 1 } });
  assert.equal(messageToJson(CollectRequest, counters).counters["1.5"], 1);
  // A key that looks like a prototype property is kept as data.
  const message = fillMessage(CollectRequest, { counters: { ["__proto__x"]: 1 } });
  assert.equal(Object.keys(message.counters)[0], "__proto__x");
});

test("unknown fields are rejected with their path", () => {
  assert.throws(
    () => fillMessage(CollectRequest, { nope: 1 }),
    (error) => error instanceof FormError && error.path === "demo.collector.CollectRequest",
  );
});
