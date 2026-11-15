import { maxOutputTokens } from './model-limits.mjs';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export function createPiModel(connection) {
  const baseUrl = connection.url.replace(/\/chat\/completions$/, '');
  const model = {
    id: connection.model, name: connection.model, api: 'openai-completions', provider: 'branch-custom', baseUrl,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: maxOutputTokens(connection),
    compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, supportsUsageInStreaming: false, maxTokensField: 'max_tokens' },
  };
  const models = createModels({ identity: { attribution: null } });
  models.setProvider(createProvider({
    id: model.provider, name: '页面配置的模型', baseUrl, models: [model], api: openAICompletionsApi(),
    auth: { apiKey: { name: '用户配置的 Key', resolve: async () => ({ auth: { apiKey: connection.key } }) } },
  }));
  return { model: models.getModel(model.provider, model.id), models };
}
export function safeModelError(error, key) {
  const message = String(error?.message || error || '');
  if (/AGENT_MODEL_FIRST_BYTE_TIMEOUT/.test(message)) return '等待模型首包超过 120 秒';
  if (/AGENT_MODEL_IDLE_TIMEOUT/.test(message)) return '模型流连续 90 秒没有新数据';
  if (/AGENT_MODEL_TOTAL_TIMEOUT/.test(message)) return '单次模型调用超过 5 分钟总时限';
  if (/AGENT_MODEL_STREAM_INTERRUPTED/.test(message)) return '模型流在完整结束前中断';
  if (/402/.test(message)) return '模型账户额度不足，请检查余额';
  if (/404/.test(message)) return '模型或接口不存在，请检查接口地址和模型名';
  if (/401|403|unauthorized|authentication|api.?key/i.test(message)) return '模型鉴权失败，请检查 API Key 与权限';
  if (/429|rate.?limit|quota|credit|balance/i.test(message)) return '模型服务限流或额度不足，请稍后重试';
  if (/tool|function.?call|stream|SSE/i.test(message)) return '模型未正确支持工具调用或流式响应，请检查模型兼容性';
  if (/timeout|timed.?out|abort/i.test(message)) return '模型请求超时或已取消';
  // Provider payloads can contain request data; keep them out of the UI and logs.
  return 'Agent 模型调用失败，请检查接口地址、模型名、网络与工具调用支持';
}
function connectionError(message) { const error = new Error(message); error.code = 'AGENT_CONNECTION'; return error; }
export async function testPiConnection(connection, signal) {
  const { model, models } = createPiModel(connection);
  const timeout = AbortSignal.timeout(30000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const result = await models.complete(model, {
    systemPrompt: '这是工具能力连接检测。必须调用 connection_check 工具，传入 ok=true；不要输出其他内容。',
    messages: [{ role: 'user', content: '请调用 connection_check。', timestamp: Date.now() }],
    tools: [{ name: 'connection_check', description: '验证模型的工具调用能力', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }],
  }, { signal: combined, maxTokens: 128, timeoutMs: 30000, maxRetries: 0, toolChoice: { type: 'function', function: { name: 'connection_check' } } });
  if (result.stopReason === 'error' || result.stopReason === 'aborted') throw connectionError(safeModelError(result.errorMessage, connection.key));
  if (!result.content.some(block => block.type === 'toolCall' && block.name === 'connection_check' && block.arguments.ok === true)) throw connectionError('这个模型没有返回有效工具调用，请选择支持 function calling 的模型');
  return { toolCalling: true, framework: 'pi-agent-core' };
}
