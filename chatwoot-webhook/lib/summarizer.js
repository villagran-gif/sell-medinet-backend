// Postprocesa la transcripción cruda de Whisper con un LLM barato:
//   - Resume la llamada en 2-3 líneas.
//   - Reformatea el texto crudo (que viene como un párrafo largo)
//     en párrafos legibles agrupados por turno de habla / tema.
//
// Usa OpenAI gpt-4o-mini por defecto (~USD 0.0005 por llamada).
// Cambiable con OPENAI_SUMMARY_MODEL.
//
// Devuelve { resumen, transcripcion_formateada }. Si el modelo falla
// el caller cae a usar el texto crudo.

const SYSTEM_PROMPT =
  "Eres un asistente que procesa transcripciones automáticas (Whisper) " +
  "de llamadas telefónicas de una clínica médica chilena. Recibís el " +
  "texto crudo y devolvés un JSON con dos campos:\n\n" +
  '- `resumen`: 2 a 3 líneas en español explicando de qué se trató la ' +
  "llamada y qué quedó pendiente. Si el audio no tiene contenido útil " +
  "(silencios, ruido, frases repetidas tipo 'Sí. Sí. Sí.'), poné " +
  "`\"Sin contenido útil.\"`.\n" +
  "- `transcripcion_formateada`: el MISMO texto pero dividido en " +
  "párrafos legibles, agrupando oraciones por turno de habla (recepcionista " +
  "vs paciente) o por tema. NO inventes, NO edites el contenido, " +
  "NO agregues nombres ni roles si no estaban. Solo dividí en párrafos " +
  "y limpiá repeticiones de muletillas evidentes.\n\n" +
  "Devolvé solo JSON válido, sin texto adicional.";

export async function summarizeAndFormat(transcript) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("missing OPENAI_API_KEY");

  const model = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai chat ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  try {
    const obj = JSON.parse(content);
    return {
      resumen: obj.resumen || null,
      transcripcion_formateada: obj.transcripcion_formateada || transcript,
      model,
    };
  } catch {
    return { resumen: null, transcripcion_formateada: transcript, model };
  }
}
