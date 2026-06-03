//! M1 #20: versioned per-tier prompt templates (PRD §6.2). A tier's template wraps
//! the ticket prompt with a system preamble that constrains the tool surface and —
//! for `basic`/`low` — forbids open-ended planning and caps the agent's turn
//! budget. Defaults are built-in and **versioned**; a per-org override can replace
//! a tier's template ([`resolve`] takes the override as a parameter, so the wiring
//! is ready before the override store + editor UI land in a later phase).

use db::models::task::ComplexityTier;

/// A per-tier system-prompt wrapper + run constraints (PRD §6.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptTemplate {
    pub tier: ComplexityTier,
    /// Bumped when the default wrapper changes; lets an org pin or upgrade.
    pub version: u32,
    /// System preamble prepended to the ticket prompt.
    pub system_wrapper: String,
    /// Turn budget for the agent run; `Some` caps it (basic/low), `None` = uncapped.
    pub max_turns: Option<u32>,
    /// The tool surface the template expects the agent to have — used by the
    /// save-time tool-availability check ([`PromptTemplate::missing_tools`]).
    pub allowed_tools: Vec<String>,
}

impl PromptTemplate {
    /// Wrap the ticket prompt with this tier's system preamble (PRD §6.2).
    pub fn wrap(&self, ticket_prompt: &str) -> String {
        format!("{}\n\n---\n\n{}", self.system_wrapper, ticket_prompt)
    }

    /// The executor CLI params that enforce the turn cap (`--max-turns N`), if any.
    /// Surfaced into the resolved CodingAgent's command via the per-run overrides.
    pub fn max_turns_params(&self) -> Option<Vec<String>> {
        self.max_turns
            .map(|n| vec!["--max-turns".to_string(), n.to_string()])
    }

    /// Tools the template expects that the agent does not provide — surfaced as a
    /// **save-time** warning (PRD §6.3: warn at save, not at runtime).
    pub fn missing_tools(&self, available: &[String]) -> Vec<String> {
        self.allowed_tools
            .iter()
            .filter(|t| !available.iter().any(|a| a == *t))
            .cloned()
            .collect()
    }
}

/// The built-in, versioned default template for a tier (PRD §6.2). `basic`/`low`
/// cap turns and forbid open-ended planning; higher tiers defer to the design
/// note / human plan and don't cap.
pub fn default_template(tier: ComplexityTier) -> PromptTemplate {
    let (version, system_wrapper, max_turns, allowed_tools): (u32, &str, Option<u32>, &[&str]) =
        match tier {
            ComplexityTier::Basic => (
                1,
                "You are completing a tightly-scoped BASIC task. Make ONLY the change described. \
                 Do NOT plan, explore, or refactor beyond the listed files. Edit exactly the files \
                 specified, honor the IO contract and the acceptance gate, and stop when they pass.",
                Some(15),
                &["read", "edit", "bash"],
            ),
            ComplexityTier::Low => (
                1,
                "You are completing a LOW-complexity task scoped to specific modules. Stay within \
                 the affected modules and the constrained tool set. Do not open-ended plan; make \
                 the change and verify it.",
                Some(30),
                &["read", "edit", "bash", "grep"],
            ),
            ComplexityTier::Medium => (
                1,
                "You are completing a MEDIUM task. Follow the design note; keep changes focused and \
                 within scope.",
                None,
                &[],
            ),
            ComplexityTier::Hard => (
                1,
                "You are completing a HARD task. Follow the provided human plan; do not deviate from \
                 its approach without surfacing the conflict.",
                None,
                &[],
            ),
            ComplexityTier::Ultra => (
                1,
                "ULTRA task — human + cloud only. This must not be auto-executed.",
                None,
                &[],
            ),
        };
    PromptTemplate {
        tier,
        version,
        system_wrapper: system_wrapper.to_string(),
        max_turns,
        allowed_tools: allowed_tools.iter().map(|s| s.to_string()).collect(),
    }
}

/// Resolve a tier's template, preferring a per-org override (PRD §6.2). The override
/// store + editor are later phases; `None` ⇒ the built-in default. Versioning lets
/// an org pin a default version or supply its own.
pub fn resolve(tier: ComplexityTier, org_override: Option<PromptTemplate>) -> PromptTemplate {
    org_override.unwrap_or_else(|| default_template(tier))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_prepends_the_system_preamble() {
        let t = default_template(ComplexityTier::Basic);
        let wrapped = t.wrap("Fix the typo in README.");
        assert!(wrapped.starts_with(&t.system_wrapper));
        assert!(wrapped.ends_with("Fix the typo in README."));
        assert!(
            wrapped.contains("---"),
            "preamble is separated from the prompt"
        );
    }

    #[test]
    fn basic_and_low_cap_turns_higher_tiers_dont() {
        assert_eq!(
            default_template(ComplexityTier::Basic).max_turns_params(),
            Some(vec!["--max-turns".to_string(), "15".to_string()])
        );
        assert_eq!(
            default_template(ComplexityTier::Low).max_turns_params(),
            Some(vec!["--max-turns".to_string(), "30".to_string()])
        );
        assert_eq!(
            default_template(ComplexityTier::Medium).max_turns_params(),
            None
        );
        assert_eq!(
            default_template(ComplexityTier::Hard).max_turns_params(),
            None
        );
    }

    #[test]
    fn basic_low_constrain_the_tool_surface() {
        assert!(
            !default_template(ComplexityTier::Basic)
                .allowed_tools
                .is_empty()
        );
        assert!(
            !default_template(ComplexityTier::Low)
                .allowed_tools
                .is_empty()
        );
    }

    #[test]
    fn missing_tools_flags_tools_the_agent_lacks() {
        let t = default_template(ComplexityTier::Low); // wants read, edit, bash, grep
        let available = ["read".to_string(), "edit".to_string()];
        let missing = t.missing_tools(&available);
        assert_eq!(missing, vec!["bash".to_string(), "grep".to_string()]);

        // All present ⇒ no warning.
        let all = ["read", "edit", "bash", "grep"].map(String::from);
        assert!(t.missing_tools(&all).is_empty());
    }

    #[test]
    fn resolve_prefers_the_org_override_else_default() {
        // Default.
        assert_eq!(
            resolve(ComplexityTier::Basic, None),
            default_template(ComplexityTier::Basic)
        );
        // Override wins (e.g. an org pinned its own wrapper + version).
        let custom = PromptTemplate {
            tier: ComplexityTier::Basic,
            version: 7,
            system_wrapper: "org-custom".to_string(),
            max_turns: Some(99),
            allowed_tools: vec![],
        };
        assert_eq!(resolve(ComplexityTier::Basic, Some(custom.clone())), custom);
    }
}
