// Transcripción vía OpenAI Whisper API.
//
// Acepta un Buffer (mp3/wav) y devuelve `{ text, model }`. Usa el endpoint
// estable `whisper-1`; para cambiar a `gpt-4o-mini-transcribe` (más barato,
// calidad similar) basta con setear OPENAI_TRANSCRIBE_MODEL.

export async function transcribe(audioBuffer, { language = "es", filename = "audio.mp3" } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("missing OPENAI_API_KEY");

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), filename);
  form.append("model", model);
  if (language) form.append("language", language);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai whisper ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return { text: data.text || "", model };
}
