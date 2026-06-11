// @tasca/anthropic-proxy — keeps the Anthropic API key inside the worker, out of the
// agent-runner (mirrors @tasca/broker's topology). The worker runs serveAnthropicProxy,
// holding the key in a closure and injecting it on the upstream HTTPS leg only; the runner
// runs serveAnthropicBridge, a keyless TCP↔unix pipe the agent's ANTHROPIC_BASE_URL points
// at. The key never crosses the unix socket, goes downstream, or is logged.
//
// Per-task attribution / metering (slice W3-S4b): the proxy tees each agent response and extracts the
// usage (SSE-aware, non-buffering — see usage-tee.ts) to a worker-supplied AgentUsageSink; the bridge
// stamps the runner's {task,org} onto each request head (request-stamp.ts). Both preserve 2b's core
// properties: the bridge stays KEYLESS (it parses only the request direction to inject ids — never a
// credential), the proxy stays a PURE STREAM (the tee forwards every byte unchanged, fail-safe).
export {
  serveAnthropicProxy,
  type AnthropicProxyOptions,
  type AnthropicProxyHandle,
  type AnthropicProxyLogger,
  type AgentUsageSink,
} from './server';
export { type AgentCallUsage } from './usage-tee';
export {
  serveAnthropicBridge,
  type AnthropicBridgeOptions,
  type AnthropicBridgeHandle,
  type AnthropicBridgeLogger,
} from './bridge';
