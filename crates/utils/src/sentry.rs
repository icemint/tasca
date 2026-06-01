//! Telemetry severed: this module is an inert no-op shim.
//!
//! Upstream wired Sentry crash/error reporting here. For this fork we ship no
//! telemetry, so the `sentry`/`sentry-tracing` crates have been removed and the
//! public API below is preserved only so existing call sites keep compiling.
//! Nothing here performs any network I/O.

use tracing_subscriber::layer::Identity;

#[derive(Clone, Copy, Debug)]
pub enum SentrySource {
    Backend,
    Desktop,
    Mcp,
    Remote,
}

/// No-op. Previously initialised the Sentry client.
pub fn init_once(_source: SentrySource) {}

/// No-op. Previously attached user identity to the Sentry scope.
pub fn configure_user_scope(_user_id: &str, _username: Option<&str>, _email: Option<&str>) {}

/// Returns an inert tracing layer (identity). Previously a Sentry layer that
/// forwarded events/breadcrumbs to Sentry.
pub fn sentry_layer() -> Identity {
    Identity::new()
}
