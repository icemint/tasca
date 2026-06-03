use std::{collections::HashMap, path::Path, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    actions::Executable,
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{BaseCodingAgent, ExecutorError, SpawnedChild, StandardCodingAgentExecutor},
    profile::{ExecutorConfig, ExecutorConfigs},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct CodingAgentInitialRequest {
    pub prompt: String,
    /// Unified executor identity + overrides
    #[serde(alias = "executor_profile_id", alias = "profile_variant_label")]
    pub executor_config: ExecutorConfig,
    /// Optional relative path to execute the agent in (relative to container_ref).
    /// If None, uses the container_ref directory directly.
    #[serde(default)]
    pub working_dir: Option<String>,
    /// Per-run environment overrides injected by the assignment engine (M1 #16):
    /// `ANTHROPIC_BASE_URL` (and optionally `ANTHROPIC_API_KEY`) pointing the
    /// agent at its assigned endpoint. `None` ⇒ no engine routing, i.e. upstream
    /// behavior. Merged into the resolved executor's command env at spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_overrides: Option<HashMap<String, String>>,
    /// Per-run extra CLI params from the tier prompt template (M1 #20): e.g.
    /// `["--max-turns", "15"]` to cap a basic/low run. `None` ⇒ no cap. Merged into
    /// the resolved executor's command (appended to `additional_params`) at spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_params: Option<Vec<String>>,
}

impl CodingAgentInitialRequest {
    pub fn base_executor(&self) -> BaseCodingAgent {
        self.executor_config.executor
    }

    pub fn effective_dir(&self, current_dir: &Path) -> std::path::PathBuf {
        match &self.working_dir {
            Some(rel_path) => current_dir.join(rel_path),
            None => current_dir.to_path_buf(),
        }
    }
}

#[async_trait]
impl Executable for CodingAgentInitialRequest {
    async fn spawn(
        &self,
        current_dir: &Path,
        approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let effective_dir = self.effective_dir(current_dir);

        let profile_id = self.executor_config.profile_id();
        let mut agent = ExecutorConfigs::get_cached()
            .get_coding_agent(&profile_id)
            .ok_or(ExecutorError::UnknownExecutorType(profile_id.to_string()))?;

        if self.executor_config.has_overrides() {
            agent.apply_overrides(&self.executor_config);
        }
        // M1 #16: inject the assigned agent's endpoint env (e.g. ANTHROPIC_BASE_URL)
        // into the resolved executor's command. No-op for executors that don't
        // carry a command env (only ClaudeCode/QwenCode are engine-routable).
        if let Some(env_overrides) = &self.env_overrides {
            agent.merge_env(env_overrides);
        }
        // M1 #20: append the tier template's extra CLI params (e.g. --max-turns) to
        // the resolved executor's command. No-op for executors without a command.
        if let Some(extra_params) = &self.extra_params {
            agent.merge_params(extra_params);
        }
        agent.use_approvals(approvals.clone());

        agent.spawn(&effective_dir, &self.prompt, env).await
    }
}
