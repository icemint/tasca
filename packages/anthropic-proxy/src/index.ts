// @tasca/anthropic-proxy — keeps the Anthropic API key inside the worker, out of the
// agent-runner (mirrors @tasca/broker's topology). The worker runs serveAnthropicProxy,
// holding the key in a closure and injecting it on the upstream HTTPS leg only; the runner
// runs serveAnthropicBridge, a keyless TCP↔unix pipe the agent's ANTHROPIC_BASE_URL points
// at. The key never crosses the unix socket, goes downstream, or is logged.
//
// Wave-3 attribution hook (NOT built here, by design): per-task cost attribution would add
// an SSE-aware usage tee in the proxy (parse the final message_delta `usage` without
// breaking the stream) plus a per-task `X-Tasca-Task-Id` header injected by an HTTP-aware
// bridge. 2b keeps the bridge a dumb keyless pipe and the proxy a pure stream — those two
// properties ARE the security + streaming value.
export {
  serveAnthropicProxy,
  type AnthropicProxyOptions,
  type AnthropicProxyHandle,
  type AnthropicProxyLogger,
} from './server';
export {
  serveAnthropicBridge,
  type AnthropicBridgeOptions,
  type AnthropicBridgeHandle,
  type AnthropicBridgeLogger,
} from './bridge';
