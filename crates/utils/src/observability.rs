//! Telemetry severed: this module is an inert no-op shim.
//!
//! Upstream wired a crash/error-reporting SDK here. For this fork we ship no
//! telemetry, so the reporting crates have been removed and the public API
//! below is preserved only so existing call sites keep compiling. Nothing here
//! performs any network I/O.

use tracing_subscriber::layer::Identity;

#[derive(Clone, Copy, Debug)]
pub enum TelemetrySource {
    Backend,
    Desktop,
    Mcp,
    Remote,
}

/// No-op. Previously initialised the crash-reporting client.
pub fn init_once(_source: TelemetrySource) {}

/// No-op. Previously attached user identity to the reporting scope.
pub fn configure_user_scope(_user_id: &str, _username: Option<&str>, _email: Option<&str>) {}

/// Returns an inert tracing layer (identity). Previously a reporting layer that
/// forwarded events/breadcrumbs to a remote collector.
pub fn tracing_noop_layer() -> Identity {
    Identity::new()
}
