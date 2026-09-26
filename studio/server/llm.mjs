import { check } from './validation.mjs';
import { geminiJSON, geminiError } from './gemini.mjs';

// Every text call (preparing, checks, hints, reviews, explanations) goes through here; TEXT_PROVIDER picks who
// answers. The prompts and schemas are the same for all of them, and every reply is checked the same way.
const TEXT = {
  gemini: { name: 'Gemini', key: 'geminiKey', env: 'GEMINI_API_KEY' },
  deepseek: { name: 'DeepSeek', key: 'deepseekKey', env: 'DEEPSEEK_API_KEY' },
  qwen: { name: '千问', key: 'dashscopeKey', env: 'DASHSCOPE_API_KEY' },
};
const text = cfg => TEXT[cfg.textProvider] || TEXT.gemini;

export function textJSON(packet, cfg, opts, request = fetch) {
  if (cfg.textProvider === 'deepseek') return deepseekJSON(packet, cfg, opts, request);
  if (cfg.textProvider === 'qwen') return qwenJSON(packet, cfg, opts, request);
  return geminiJSON(packet, cfg, opts, request);
}
export const textConfigured = cfg => Boolean(cfg[text(cfg).key]);
export const textName = cfg => text(cfg).name;
export const textModel = cfg => cfg.textProvider === 'deepseek' ? cfg.deepseekModel : cfg.textProvider === 'qwen' ? cfg.qwenTextModel : cfg.geminiModel;
export const textKeyMissing = cfg => `请在「设置」里填写 ${text(cfg).name} 的 API key（本机版也可以写在 .env 的 ${text(cfg).env}）。`;

// Strict mode holds every object to its listed properties, all of them required. A schema that leaves one
// optional is not strict-shaped, and is sent the lenient way instead.
export function strictShaped(schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required || []);
    if (schema.additionalProperties !== false || Object.keys(schema.properties || {}).some(k => !required.has(k))) return false;
  }
  return Object.values(schema.properties || {}).every(strictShaped) && strictShaped(schema.items)
    && [...(schema.anyOf || []), ...(schema.oneOf || [])].every(strictShaped);
}

// The OpenAI-shaped chat endpoint DeepSeek and Qwen both offer. With `strict` the service holds the reply to
// the schema itself; without it only JSON is promised, so the shape is spelled out in the instructions.
async function chatJSON(packet, cfg, { instructions, schema, tokens = 4096, limit = 12000, purpose = null, timeout = cfg.geminiTimeout, model },
  { name, url, apiKey, strict, extra = {} }, request) {
  const system = strict ? instructions : `${instructions}\n\n只输出一个 JSON 对象，不要输出任何其他文字。这个对象必须符合下面的 JSON Schema，字段名原样使用：\n${JSON.stringify(schema)}`;
  let response;
  try {
    response = await request(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // Thinking counts against max_tokens, so leave room for both.
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(packet) }],
        response_format: strict ? { type: 'json_schema', json_schema: { name: purpose || 'reply', strict: true, schema } } : { type: 'json_object' },
        max_tokens: tokens * 2, ...extra }),
    });
  } catch { throw new Error(`${name} network error or timeout`); }
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
  const data = await response.json(), choice = data.choices?.[0], u = data.usage;
  // Thinking is inside completion_tokens and billed as output, so it is not counted a second time.
  cfg.usage?.record({ purpose, model: typeof data.model === 'string' ? data.model : model,
    usage: u && { promptTokenCount: u.prompt_tokens, candidatesTokenCount: u.completion_tokens } });
  check(choice?.finish_reason === 'stop', `Invalid ${name} response`);
  const raw = choice.message?.content;
  check(typeof raw === 'string' && raw && raw.length <= limit, `Invalid ${name} response`);
  return { value: JSON.parse(raw), model: typeof data.model === 'string' ? data.model.slice(0, 100) : model };
}

// DeepSeek refuses "json_schema" (tried 2026-09-25).
export function deepseekJSON(packet, cfg, opts, request = fetch) {
  check(cfg.deepseekKey, textKeyMissing({ textProvider: 'deepseek' }), 503);
  return chatJSON(packet, cfg, { model: cfg.deepseekModel, ...opts },
    { name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', apiKey: cfg.deepseekKey, strict: false }, request);
}

// Qwen on Model Studio keeps to a strict schema when the schema is strict-shaped (tried in 一题, 2026-09-26);
// if it still turns one down, the lenient way is tried once more. It thinks first by default, which is too
// slow to wait on here, so thinking is off unless QWEN_THINKING=on.
export async function qwenJSON(packet, cfg, opts, request = fetch) {
  check(cfg.dashscopeKey, textKeyMissing({ textProvider: 'qwen' }), 503);
  const host = cfg.dashscopeRegion === 'cn-beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
  const call = strict => chatJSON(packet, cfg, { model: cfg.qwenTextModel, ...opts },
    { name: 'Qwen', url: `https://${host}/compatible-mode/v1/chat/completions`, apiKey: cfg.dashscopeKey, strict, extra: { enable_thinking: cfg.qwenThinking } }, request);
  if (!strictShaped(opts.schema)) return call(false);
  try { return await call(true); }
  catch (e) { if (e.message === 'Qwen HTTP 400') return call(false); throw e; }
}

export function textError(error) {
  const who = /^(DeepSeek|Qwen)\b/.exec(error.message)?.[1];
  if (!who) return geminiError(error);
  const name = who === 'Qwen' ? '千问' : 'DeepSeek';
  if (new RegExp(`^${who} HTTP (401|403)$`).test(error.message)) return `${name}没有接受请求：key 不对，或者没有这个模型的权限。`;
  if (error.message === `${who} HTTP 402`) return `${name}账户余额不足，充值后可以重试。`;
  if (error.message === `${who} HTTP 429`) return `${name}请求太频繁，稍后再试。`;
  if (error.message === `${who} network error or timeout`) return `${name}暂时连接不上或等待超时，可以重试。`;
  return `这次未取得有效的${name}内容，可以重试。`;
}
