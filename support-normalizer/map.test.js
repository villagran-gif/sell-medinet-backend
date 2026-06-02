import { test } from "node:test";
import assert from "node:assert/strict";
import { mapMessageCreated, mapStatus } from "./map.js";

const base = {
  event: "message_created",
  message_type: "incoming",
  content: "Hola, necesito ayuda",
  created_at: "2026-06-02T22:00:00Z",
  sender: { id: 55, name: "Juana Pérez", phone_number: "+56912345678", email: "j@x.cl" },
  conversation: { id: 1038, status: "open", inbox_id: 107690 },
  inbox: { id: 107690, name: "Soporte WA" },
};

test("mapea un mensaje incoming a contact+conversation+comment", () => {
  const m = mapMessageCreated(base);
  assert.equal(m.conversation.chatwootId, 1038);
  assert.equal(m.conversation.inboxId, 107690);
  assert.equal(m.conversation.status, "open");
  assert.equal(m.contact.chatwootId, 55);
  assert.equal(m.contact.phone, "+56912345678");
  assert.equal(m.contact.email, "j@x.cl");
  assert.equal(m.comment.body, "Hola, necesito ayuda");
  assert.equal(m.comment.isIncoming, true);
  assert.equal(m.comment.isPublic, true);
  assert.match(m.conversation.subject, /#1038/);
});

test("outgoing (agente) → comentario no-incoming", () => {
  const m = mapMessageCreated({ ...base, message_type: "outgoing", content: "Te ayudo" });
  assert.equal(m.comment.isIncoming, false);
});

test("private:true → comentario no público", () => {
  const m = mapMessageCreated({ ...base, private: true });
  assert.equal(m.comment.isPublic, false);
});

test("ignora eventos que no son message_created", () => {
  assert.equal(mapMessageCreated({ event: "conversation_created" }), null);
});

test("ignora message_type activity/template", () => {
  assert.equal(mapMessageCreated({ ...base, message_type: "activity" }), null);
  assert.equal(mapMessageCreated({ ...base, message_type: "template" }), null);
});

test("ignora contenido vacío (solo adjuntos) por ahora", () => {
  assert.equal(mapMessageCreated({ ...base, content: "   " }), null);
});

test("ignora payload sin conversation.id", () => {
  assert.equal(mapMessageCreated({ ...base, conversation: { status: "open" } }), null);
});

test("cae a conversation.meta.sender cuando no hay sender top-level", () => {
  const m = mapMessageCreated({
    event: "message_created",
    message_type: "incoming",
    content: "x",
    conversation: { id: 5, meta: { sender: { phone_number: "+569" } } },
  });
  assert.equal(m.contact.phone, "+569");
  assert.equal(m.contact.chatwootId, null);
  assert.equal(m.conversation.chatwootId, 5);
});

test("mapStatus traduce el vocabulario de Chatwoot a Zendesk", () => {
  assert.equal(mapStatus("resolved"), "solved");
  assert.equal(mapStatus("pending"), "pending");
  assert.equal(mapStatus("snoozed"), "hold");
  assert.equal(mapStatus("open"), "open");
  assert.equal(mapStatus("loquesea"), "open");
});
