//! M1 routing core (PRD §5.1): resolve an assigned agent's profile + endpoint
//! into an [`ExecutorConfig`] plus the per-run [`CmdOverrides`] env that points
//! ClaudeCode/QwenCode at an alternate (local Ollama or cloud) endpoint.

use std::{collections::HashMap, str::FromStr};

use crate::{command::CmdOverrides, executors::BaseCodingAgent, profile::ExecutorConfig};

/// Env vars ClaudeCode/QwenCode read to target an alternate endpoint.
const ANTHROPIC_BASE_URL: &str = "ANTHROPIC_BASE_URL";
const ANTHROPIC_API_KEY: &str = "ANTHROPIC_API_KEY";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AgentEnvError {
    #[error("unknown executor profile: {0}")]
    UnknownProfile(String),
    /// An endpoint override (`base_url`) was requested for an executor that does
    /// not read `ANTHROPIC_BASE_URL`. Injecting the env would be silently ignored
    /// by that executor (mis-routing the run to the default endpoint), so the
    /// assignment is rejected instead — `decide()` treats it as undispatchable.
    #[error("executor {0} does not support an endpoint override (ANTHROPIC_BASE_URL)")]
    EndpointOverrideUnsupported(BaseCodingAgent),
}

/// Whether an executor honors `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`. Only the
/// Anthropic-API-compatible executors do; routing any other executor to a custom
/// endpoint via these vars would silently no-op (see [`StandardCodingAgentExecutor::merge_env`]).
fn honors_anthropic_endpoint_env(executor: BaseCodingAgent) -> bool {
    matches!(
        executor,
        BaseCodingAgent::ClaudeCode | BaseCodingAgent::QwenCode
    )
}

/// Map an assigned agent into the executor config + the per-run env overrides the
/// caller injects when starting the session (PRD §5.1).
///
/// - `executor_profile` (the agent's `executor_profile`) resolves to a
///   [`BaseCodingAgent`].
/// - `base_url` → `ANTHROPIC_BASE_URL` (e.g. a host Ollama endpoint).
/// - `api_key` → `ANTHROPIC_API_KEY`. **Phase-1 stopgap:** the caller supplies
///   this from the host env/config; the `credential_ref` → secret-store path
///   lands in Phase 2. The key is only injected alongside a `base_url`.
///
/// The caller keeps `disable_api_key = false` so the injected key survives the
/// executor spawn (see `claude.rs`); QwenCode never removes the key.
pub fn resolve_agent_executor(
    executor_profile: &str,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(ExecutorConfig, CmdOverrides), AgentEnvError> {
    let executor = BaseCodingAgent::from_str(executor_profile)
        .map_err(|_| AgentEnvError::UnknownProfile(executor_profile.to_string()))?;
    let config = ExecutorConfig::new(executor);

    let mut env = HashMap::new();
    if let Some(url) = base_url.map(str::trim).filter(|s| !s.is_empty()) {
        // Only inject the endpoint env for an executor that actually reads it.
        // Otherwise the run would silently target the default endpoint while the
        // engine believes it routed correctly — reject so the agent is treated as
        // undispatchable rather than mis-routed.
        if !honors_anthropic_endpoint_env(executor) {
            return Err(AgentEnvError::EndpointOverrideUnsupported(executor));
        }
        env.insert(ANTHROPIC_BASE_URL.to_string(), url.to_string());
        if let Some(key) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
            env.insert(ANTHROPIC_API_KEY.to_string(), key.to_string());
        }
    }

    let cmd = CmdOverrides {
        env: if env.is_empty() { None } else { Some(env) },
        ..Default::default()
    };
    Ok((config, cmd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_base_url_and_key_for_a_cloud_agent() {
        let (config, cmd) = resolve_agent_executor(
            "CLAUDE_CODE",
            Some("https://cloud.example/v1"),
            Some("sk-test"),
        )
        .unwrap();
        assert_eq!(config.executor, BaseCodingAgent::ClaudeCode);
        let env = cmd.env.expect("env present when base_url is set");
        assert_eq!(
            env.get(ANTHROPIC_BASE_URL).map(String::as_str),
            Some("https://cloud.example/v1")
        );
        assert_eq!(
            env.get(ANTHROPIC_API_KEY).map(String::as_str),
            Some("sk-test")
        );
    }

    #[test]
    fn ollama_base_url_without_key_omits_the_key() {
        // A local Ollama endpoint needs no API key; the key is simply absent
        // (never removed — disable_api_key stays false at the call site).
        let (_, cmd) =
            resolve_agent_executor("QWEN_CODE", Some("http://mac.tailnet:11434"), None).unwrap();
        let env = cmd.env.expect("env present when base_url is set");
        assert_eq!(
            env.get(ANTHROPIC_BASE_URL).map(String::as_str),
            Some("http://mac.tailnet:11434")
        );
        assert!(!env.contains_key(ANTHROPIC_API_KEY));
    }

    #[test]
    fn no_base_url_means_no_env_overrides() {
        // No endpoint override ⇒ behave exactly as upstream (no injected env).
        let (_, cmd) = resolve_agent_executor("CLAUDE_CODE", None, Some("sk-ignored")).unwrap();
        assert!(cmd.env.is_none());
    }

    #[test]
    fn unknown_profile_is_an_error() {
        assert_eq!(
            resolve_agent_executor("NOT_A_REAL_AGENT", None, None),
            Err(AgentEnvError::UnknownProfile(
                "NOT_A_REAL_AGENT".to_string()
            ))
        );
    }

    #[test]
    fn endpoint_override_on_non_honoring_executor_is_rejected() {
        // GEMINI does not read ANTHROPIC_BASE_URL: injecting it would silently
        // mis-route the run, so an endpoint override must be rejected (making the
        // agent undispatchable) rather than producing env the executor ignores.
        assert_eq!(
            resolve_agent_executor("GEMINI", Some("http://ollama.local:11434"), None),
            Err(AgentEnvError::EndpointOverrideUnsupported(
                BaseCodingAgent::Gemini
            ))
        );
    }

    #[test]
    fn non_honoring_executor_without_endpoint_override_is_fine() {
        // No base_url ⇒ no routing env ⇒ no mis-routing risk; any executor is OK.
        let (config, cmd) = resolve_agent_executor("GEMINI", None, None).unwrap();
        assert_eq!(config.executor, BaseCodingAgent::Gemini);
        assert!(cmd.env.is_none());
    }
}
