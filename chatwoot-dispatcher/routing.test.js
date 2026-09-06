import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractInboxId,
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
