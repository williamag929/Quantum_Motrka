'use strict';

/**
 * Claude-powered email triage.
 * Returns { action, confidence, draft, reason } for each email.
 */

const { default: Anthropic } = require('@anthropic-ai/sdk');

const SYSTEM =
  'You are an expert email triage agent. Analyze the email and reply with ONLY valid JSON:\n' +
  '{"action":"spam|ignore|reply|flag","confidence":1,"draft":null,"reason":""}\n\n' +
  'Action rules:\n' +
  '  spam   — promotional, newsletter, cold outreach, bulk, phishing\n' +
  '  ignore — read-only notification or alert that needs no reply\n' +
  '  reply  — genuine message from a real person that warrants a response\n' +
  '  flag   — urgent, legal, financial, medical, or high-stakes — escalate to human\n\n' +
  'confidence: integer 1–10 (how certain you are about classification AND draft quality)\n' +
  'draft: for action=reply write a complete, polite reply in the SAME LANGUAGE as the original; null otherwise\n' +
  'reason: one sentence explaining the classification';

async function triage(email) {
  const client = new Anthropic();

  const content =
    `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.body}`;

  const resp = await client.messages.create({
    model:      'claude-opus-4-7',
    max_tokens: 1024,
    thinking:   { type: 'adaptive' },
    system:     SYSTEM,
    messages:   [{ role: 'user', content }],
  });

  const text      = resp.content.find(b => b.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Triage returned no JSON. Response: ' + text.slice(0, 120));

  const r = JSON.parse(jsonMatch[0]);
  return {
    action:     ['spam', 'ignore', 'reply', 'flag'].includes(r.action) ? r.action : 'ignore',
    confidence: Math.max(1, Math.min(10, parseInt(r.confidence, 10) || 5)),
    draft:      r.draft ?? null,
    reason:     r.reason ?? '',
  };
}

module.exports = { triage };
