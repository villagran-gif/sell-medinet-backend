import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractInboxId,
  extractSenderPhone,
  parseRoutingConfig,
  resolveHandlerKeys,
  DEFAULT_HANDLER,
} from "./routing.js";

test("DEFAULT_HANDLER es antonia", () => {
  assert.equal(DEFAULT_HANDLER, "antonia");
});

test("config por default rutea TODO a antonia", () => {
  const cfg = parseRoutingConfig({});
  assert.deepEqual(cfg.routes, {});
  assert.deepEqual(cfg.defaultKeys, ["antonia"]);
  assert.deepEqual(resolveHandlerKeys({ inbox: { id: 999 } }, cfg), ["antonia"]);
  assert.deepEqual(resolveHandlerKeys({}, cfg), ["antonia"]);
});

test("extractInboxId prueba múltiples shapes de Chatwoot", () => {
  assert.equal(extractInboxId({ inbox: { id: 5 } }), 5);
  assert.equal(extractInboxId({ conversation: { inbox_id: 7 } }), 7);
  assert.equal(extractInboxId({ conversation: { inbox: { id: 8 } } }), 8);
  assert.equal(extractInboxId({ conversation: { meta: { inbox_id: 9 } } }), 9);
  assert.equal(extractInboxId({ contact_inbox: { inbox_id: 10 } }), 10);
  assert.equal(extractInboxId({}), null);
  assert.equal(extractInboxId(null), null);
});


test("extractSenderPhone reconoce shapes reales de Chatwoot", () => {
  assert.equal(extractSenderPhone({ sender: { phone_number: "+56 9 8729 7033" } }), "56987297033");
  assert.equal(extractSenderPhone({ conversation: { meta: { sender: { phone_number: "56987297033" } } } }), "56987297033");
  assert.equal(extractSenderPhone({ contact: { phone_number: "+56987297033" } }), "56987297033");
  assert.equal(extractSenderPhone({}), "");
});

test("puente directo en test usa teléfono de prueba y no conversation id", () => {
  const cfg = parseRoutingConfig({
    ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_ENABLED: "true",
    ATTENDANCE_DIRECT_MODE: "test",
  });
  const base = { account: { id: 162472 }, conversation: { id: 11738, inbox_id: 107690 } };
  assert.deepEqual(resolveHandlerKeys({ ...base, sender: { phone_number: "+56987297033" } }, cfg), ["attendance_direct_chatwoot"]);
  assert.deepEqual(resolveHandlerKeys({ ...base, sender: { phone_number: "+56911111111" } }, cfg), ["antonia"]);
});

test("puente directo live toma todo el inbox exclusivo", () => {
  const cfg = parseRoutingConfig({
    ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_ENABLED: "true",
    ATTENDANCE_DIRECT_MODE: "live",
  });
  const payload = { account: { id: 162472 }, conversation: { id: 99123, inbox_id: 107690 }, sender: { phone_number: "+56911111111" } };
  assert.deepEqual(resolveHandlerKeys(payload, cfg), ["attendance_direct_chatwoot"]);
});

test("una ruta antigua que incluya melania queda sólo en AntonIA", () => {
  const cfg = parseRoutingConfig({
    CHATWOOT_DISPATCH_ROUTES: JSON.stringify({
      107690: ["antonia", "melania"],
    }),
  });
  assert.deepEqual(resolveHandlerKeys({ inbox: { id: 107690 } }, cfg), ["antonia"]);
  assert.deepEqual(resolveHandlerKeys({ inbox: { id: 1 } }, cfg), ["antonia"]);
});

test("un default antiguo melania se ignora y vuelve a AntonIA", () => {
  const cfg = parseRoutingConfig({ CHATWOOT_DISPATCH_DEFAULT: "melania" });
  assert.deepEqual(cfg.defaultKeys, ["antonia"]);
});

test("JSON inválido en ROUTES cae a AntonIA", () => {
  const cfg = parseRoutingConfig({ CHATWOOT_DISPATCH_ROUTES: "{no es json" });
  assert.deepEqual(cfg.routes, {});
  assert.deepEqual(cfg.defaultKeys, ["antonia"]);
});

test("default vacío vuelve a AntonIA", () => {
  const cfg = parseRoutingConfig({ CHATWOOT_DISPATCH_DEFAULT: "  ,  " });
  assert.deepEqual(cfg.defaultKeys, ["antonia"]);
});
