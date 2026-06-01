//! Telemetry severed: analytics is an inert no-op shim.
//!
//! Upstream sent product analytics to a third-party SaaS endpoint from the
//! remote server. This fork ships no telemetry: the HTTP client and the
//! event-capture calls have been removed. The public types remain so call
//! sites compile; `from_env` always returns `None`, so an `AnalyticsService`
//! is never constructed.

use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AnalyticsConfig;

impl AnalyticsConfig {
    /// Telemetry severed: analytics is never configured.
    pub fn from_env() -> Option<Self> {
        None
    }
}

#[derive(Clone, Debug)]
pub struct AnalyticsService;

impl AnalyticsService {
    pub fn new(_config: AnalyticsConfig) -> Self {
        Self
    }

    /// No-op. Previously POSTed an event to a third-party analytics endpoint.
    pub fn track(&self, _user_id: Uuid, _event_name: &str, _properties: Value) {}
}
