from pathlib import Path

p = Path('chatwoot-webhook/transcription/polling.js')
s = p.read_text(encoding='utf-8')

anchor = '''function basicAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error("missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
  return "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64");
}
'''
helper = anchor + '''\nexport function isWithinRecentWindow(item, cutoffMs, fields = []) {
  for (const field of fields) {
    const raw = item?.[field];
    if (!raw) continue;
    const ts = new Date(raw).getTime();
    if (Number.isFinite(ts)) return ts >= cutoffMs;
  }
  // Si Twilio cambia el shape y no trae una fecha parseable, no descartamos
  // silenciosamente el evento: preferimos procesarlo por seguridad.
  return true;
}
'''
if s.count(anchor) != 1:
    raise SystemExit('basicAuth anchor mismatch')
s = s.replace(anchor, helper, 1)

old_recordings = '''  const data = await res.json();
  return data.recordings || [];
}
'''
new_recordings = '''  const data = await res.json();
  const cutoffMs = Date.now() - minutesBack * 60_000;
  return (data.recordings || []).filter((rec) =>
    isWithinRecentWindow(rec, cutoffMs, ["date_created", "date_updated"])
  );
}
'''
if s.count(old_recordings) != 1:
    raise SystemExit('recordings anchor mismatch')
s = s.replace(old_recordings, new_recordings, 1)

old_calls = '''  const data = await res.json();
  return (data.calls || []).filter((c) => c.direction === "inbound");
}
'''
new_calls = '''  const data = await res.json();
  const cutoffMs = Date.now() - minutesBack * 60_000;
  return (data.calls || []).filter(
    (c) =>
      c.direction === "inbound" &&
      isWithinRecentWindow(c, cutoffMs, ["start_time", "date_created", "end_time"])
  );
}
'''
if s.count(old_calls) != 1:
    raise SystemExit('calls anchor mismatch')
s = s.replace(old_calls, new_calls, 1)

p.write_text(s, encoding='utf-8')
