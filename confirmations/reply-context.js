// An appointment response must quote a recorded request, not merely share a phone.
export function extractAttendanceReply(payload) {
  if (payload?.event !== 'message_created' || payload?.private === true
      || !['incoming', 0].includes(payload?.message_type)) return null;
  const id = positiveId(payload.id);
  const conversationId = positiveId(payload.conversation?.id);
  const inboxId = positiveId(payload.conversation?.inbox_id);
  const replyTo = positiveId(payload.content_attributes?.in_reply_to);
  const phone = String(payload.sender?.phone_number || '').replace(/\D/g, '');
  const content = String(payload.content || '').trim();
  if (positiveId(payload.account?.id) !== '162472' || !id || !conversationId || inboxId !== '110652' || !replyTo || !phone || !content) return null;
  return { id, conversationId, inboxId, replyTo, phone, content };
}

export function positiveId(value) {
  const s = String(value ?? '');
  return /^[1-9]\d*$/.test(s) ? s : null;
}
