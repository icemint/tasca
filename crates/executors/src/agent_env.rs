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
}
