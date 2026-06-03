//! Per-tier required-field gate (PRD §6.1). A **pure** check: given a task's tier
//! and the set of fields actually present on the ticket, report what's missing — or
//! that an `ultra` ticket can't be auto-started at all. The caller extracts the
//! present-field set from the linked issue and blocks the start when this is not
//! [`ValidationResult::Ok`].

use std::collections::HashSet;

use db::models::task::ComplexityTier;

/// A required ticket field (PRD §6.1). The bar rises with tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequiredField {
    Title,
    ExactFiles,
    IoContract,
    AcceptanceGate,
    EdgeCases,
    AffectedModules,
    ConstrainedTools,
    DesignNote,
    HumanPlan,
}

impl RequiredField {
    /// Stable key — used both as the `extension_metadata` JSON key the field is
    /// read from and as the label in the missing-field checklist shown on a block.
    pub fn key(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::ExactFiles => "exact_files",
            Self::IoContract => "io_contract",
            Self::AcceptanceGate => "acceptance_gate",
            Self::EdgeCases => "edge_cases",
            Self::AffectedModules => "affected_modules",
            Self::ConstrainedTools => "constrained_tools",
            Self::DesignNote => "design_note",
            Self::HumanPlan => "human_plan",
        }
    }
}

/// Fields required to auto-start a task at `tier` (PRD §6.1). **Cumulative** — each
/// tier adds to the one below. `ultra` is special (see [`validate_required_fields`]),
/// so its set here is the `hard` set; the ultra human+cloud rule is applied by the
/// validator, not by this table.
pub fn required_fields(tier: ComplexityTier) -> Vec<RequiredField> {
    use RequiredField::*;
    // basic
    let mut fields = vec![Title, ExactFiles, IoContract, AcceptanceGate, EdgeCases];
    if tier >= ComplexityTier::Low {
        fields.extend([AffectedModules, ConstrainedTools]);
    }
    if tier >= ComplexityTier::Medium {
        fields.push(DesignNote);
    }
    if tier >= ComplexityTier::Hard {
        fields.push(HumanPlan);
    }
    fields
}

/// The outcome of the required-field gate (PRD §6.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationResult {
    /// All required fields present — the task may start.
    Ok,
    /// Required fields are missing — block the start and surface this checklist.
    MissingFields(Vec<RequiredField>),
    /// `ultra` tasks are human + cloud only and are never auto-started (PRD §6.1).
    RequiresHumanCloud,
}

/// Validate a task's present fields against its tier's requirements (PRD §6.1).
/// Pure. Because [`required_fields`] is cumulative, raising a tier after fields are
/// filled only ever surfaces the *newly* required fields (PRD §6.3) — already-present
/// fields are never re-listed.
pub fn validate_required_fields(
    tier: ComplexityTier,
    present: &HashSet<RequiredField>,
) -> ValidationResult {
    if tier == ComplexityTier::Ultra {
        return ValidationResult::RequiresHumanCloud;
    }
    let missing: Vec<RequiredField> = required_fields(tier)
        .into_iter()
        .filter(|f| !present.contains(f))
        .collect();
    if missing.is_empty() {
        ValidationResult::Ok
    } else {
        ValidationResult::MissingFields(missing)
    }
}

#[cfg(test)]
mod tests {
    use super::{RequiredField::*, *};

    fn present(fields: &[RequiredField]) -> HashSet<RequiredField> {
        fields.iter().copied().collect()
    }

    /// The full set that satisfies `hard` (the most-demanding auto-startable tier).
    fn all_hard_fields() -> HashSet<RequiredField> {
        present(&[
            Title,
            ExactFiles,
            IoContract,
            AcceptanceGate,
            EdgeCases,
            AffectedModules,
            ConstrainedTools,
            DesignNote,
            HumanPlan,
        ])
    }

    #[test]
    fn required_sets_are_cumulative_per_tier() {
        assert_eq!(required_fields(ComplexityTier::Basic).len(), 5);
        assert_eq!(required_fields(ComplexityTier::Low).len(), 7);
        assert_eq!(required_fields(ComplexityTier::Medium).len(), 8);
        assert_eq!(required_fields(ComplexityTier::Hard).len(), 9);
        // Each tier's set is a superset of the one below.
        for (lower, higher) in [
            (ComplexityTier::Basic, ComplexityTier::Low),
            (ComplexityTier::Low, ComplexityTier::Medium),
            (ComplexityTier::Medium, ComplexityTier::Hard),
        ] {
            let lo = present(&required_fields(lower));
            let hi = present(&required_fields(higher));
            assert!(
                lo.is_subset(&hi),
                "{lower:?} must be a subset of {higher:?}"
            );
        }
    }

    #[test]
    fn empty_fields_lists_the_whole_tier_requirement() {
        let empty = HashSet::new();
        for (tier, n) in [
            (ComplexityTier::Basic, 5),
            (ComplexityTier::Low, 7),
            (ComplexityTier::Medium, 8),
            (ComplexityTier::Hard, 9),
        ] {
            match validate_required_fields(tier, &empty) {
                ValidationResult::MissingFields(missing) => assert_eq!(missing.len(), n),
                other => panic!("{tier:?} with no fields should be MissingFields, got {other:?}"),
            }
        }
    }

    #[test]
    fn complete_fields_pass_each_auto_startable_tier() {
        let all = all_hard_fields();
        for tier in [
            ComplexityTier::Basic,
            ComplexityTier::Low,
            ComplexityTier::Medium,
            ComplexityTier::Hard,
        ] {
            assert_eq!(
                validate_required_fields(tier, &all),
                ValidationResult::Ok,
                "{tier:?} with all fields should pass"
            );
        }
    }

    #[test]
    fn ultra_always_requires_human_cloud() {
        // Even with every field present, ultra cannot be auto-started.
        assert_eq!(
            validate_required_fields(ComplexityTier::Ultra, &all_hard_fields()),
            ValidationResult::RequiresHumanCloud
        );
        assert_eq!(
            validate_required_fields(ComplexityTier::Ultra, &HashSet::new()),
            ValidationResult::RequiresHumanCloud
        );
    }

    /// PRD §6.3: raising a tier after the lower tier's fields are filled surfaces
    /// ONLY the newly-required fields, never the already-satisfied ones.
    #[test]
    fn raising_tier_prompts_only_newly_required_fields() {
        // Satisfied exactly the `basic` set, now the task is `medium`.
        let basic_filled = present(&required_fields(ComplexityTier::Basic));
        let ValidationResult::MissingFields(missing) =
            validate_required_fields(ComplexityTier::Medium, &basic_filled)
        else {
            panic!("medium with only basic fields must be MissingFields");
        };
        // Only the medium-tier additions over basic: affected_modules, constrained_tools, design_note.
        let missing_set = present(&missing);
        assert_eq!(
            missing_set,
            present(&[AffectedModules, ConstrainedTools, DesignNote]),
            "must prompt only the newly-required fields, not the satisfied basic ones"
        );
    }
}
