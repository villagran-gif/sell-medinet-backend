import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichChatwootPayloadWithMediaContext,
  getIncomingImageAttachments,
} from "../antonia-bridge/media-context.js";

test("detecta sólo imágenes de mensajes incoming", () => {
  const incoming = {
    id: 10,
    message_type: "incoming",
    attachments: [
      { file_type: "image", content_type: "image/jpeg", data_url: "https://example.test/a.jpg" },
      { file_type: "audio", content_type: "audio/ogg", data_url: "https://example.test/a.ogg" },
    ],
  };
  assert.equal(getIncomingImageAttachments(incoming).length, 1);

  const outgoing = { ...incoming, message_type: "outgoing" };
  assert.equal(getIncomingImageAttachments(outgoing).length, 0);
});

test("enriquece una copia del payload sin mutar el evento crudo", async () => {
  const payload = {
    id: 11,
    message_type: "incoming",
    content: "¿De qué se trata?",
    attachments: [
      { file_type: "image", content_type: "image/jpeg", data_url: "https://example.test/post.jpg" },
    ],
    additional_attributes: { original: true },
  };

  const fakeFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content[1].type, "image_url");
    assert.equal(body.messages[0].content[1].image_url.url, "https://example.test/post.jpg");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            { message: { content: "Publicación sobre cirugía bariátrica y evaluación médica." } },
          ],
        });
      },
    };
  };

  const enriched = await enrichChatwootPayloadWithMediaContext(payload, {
    apiKey: "test-key",
    model: "test-vision-model",
    fetchImpl: fakeFetch,
    timeoutMs: 1000,
  });

  assert.notEqual(enriched, payload);
  assert.equal(payload.content, "¿De qué se trata?");
  assert.match(enriched.content, /¿De qué se trata\?/);
  assert.match(enriched.content, /CONTEXTO_VISUAL_INTERNO/);
  assert.match(enriched.content, /cirugía bariátrica/);
  assert.equal(enriched.additional_attributes.original, true);
  assert.equal(enriched.additional_attributes.antonia_media_context.image_count, 1);
  assert.equal(enriched.additional_attributes.antonia_media_context.analyzed_count, 1);
});

test("un mensaje sin imágenes pasa sin cambios", async () => {
  const payload = { id: 12, message_type: "incoming", content: "Hola" };
  const result = await enrichChatwootPayloadWithMediaContext(payload, {
    apiKey: "test-key",
    fetchImpl: async () => { throw new Error("no debería llamarse"); },
  });
  assert.equal(result, payload);
});
