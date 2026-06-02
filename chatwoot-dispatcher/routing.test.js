import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractInboxId,
  parseRoutingConfig,
  resolveHandlerKeys,
  DEFAULT_HANDLER,
} from "./routing.js";

test("DEFAULT_HANDLER es melania", () => {
  assert.equal(DEFAULT_HANDLER, "melania");
});

test("config por default rutea TODO a melania (behavior-preserving)", () => {
  const cfg = parseRoutingConfig({});
  assert.deepEqual(cfg.routes, {});
  assert.deepEqual(cfg.defaultKeys, ["melania"]);
  assert.deepEqual(resolveHandlerKeys({ inbox: { id: 999 } }, cfg), ["melania"]);
  assert.deepEqual(resolveHandlerKeys({}, cfg), ["melania"]);
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

test("una ruta explícita por inbox sobreescribe el default", () => {
  const cfg = parseRoutingConfig({
    CHATWOOT_DISPATCH_ROUTES: JSON.stringify({
      107690: ["support-normalizer", "melania"],
    }),
  });
  assert.deepEqual(resolveHandlerKeys({ inbox: { id: 107690 } }, cfg), [
    "support-normalizer",
    "melania",
  ]);
  // inbox sin ruta explícita cae al default
  assert.deepEqual(resolveHandlerKeys({ inbox: { id: 1 } }, cfg), ["melania"]);
});

test("CHATWOOT_DISPATCH_DEFAULT redefine los handlers por default", () => {
  const cfg = parseRoutingConfig({
    CHATWOOT_DISPATCH_DEFAULT: "support-normalizer, melania",
  });
  assert.deepEqual(cfg.defaultKeys, ["support-normalizer", "melania"]);
});

test("JSON inválido en ROUTES cae a default seguro, no rompe", () => {
  const cfg = parseRoutingConfig({ CHATWOOT_DISPATCH_ROUTES: "{no es json" });
  assert.deepEqual(cfg.routes, {});
  assert.deepEqual(cfg.defaultKeys, ["melania"]);
});

test("default vacío vuelve a melania", () => {
  const cfg = parseRoutingConfig({ CHATWOOT_DISPATCH_DEFAULT: "  ,  " });
  assert.deepEqual(cfg.defaultKeys, ["melania"]);
});
