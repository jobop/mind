export function sseMessage(calls, model = 'tool-capable-model', text = null) {
  const chunks = [];
  if (text !== null) chunks.push({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  for (const [index, call] of (calls || []).entries()) {
    chunks.push({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index, id: 'call_' + index, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] });
    const args = JSON.stringify(call.args);
    const mid = Math.floor(args.length / 2);
    for (const fragment of [args.slice(0, mid), args.slice(mid)]) chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: fragment } }] }, finish_reason: null }] });
  }
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: text !== null ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
  return new Response(chunks.map((chunk, i) => 'data: ' + JSON.stringify({ id: 'response_' + i, object: 'chat.completion.chunk', created: 1, model, ...chunk }) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
