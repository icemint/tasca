mod analytics;
mod app;
pub mod attachments;
pub mod audit;
mod auth;
pub mod azure_blob;
mod billing;
pub mod config;
pub mod db;
pub mod digest;
pub mod github_app;
pub mod mail;
mod middleware;
pub mod mutation_definition;
pub mod notifications;
pub mod r2;
pub mod routes;
pub mod shape_definition;
pub mod shape_route;
pub mod shape_routes;
pub mod shapes;
mod shared_key_auth;
mod state;

use std::env;

pub use app::Server;
pub use billing::BillingService;
pub use state::AppState;
use tracing_error::ErrorLayer;
use tracing_subscriber::{
    Layer,
    fmt::{self, format::FmtSpan},
    layer::SubscriberExt,
    util::SubscriberInitExt,
};
pub use utils::observability::{TelemetrySource, init_once as telemetry_init_once};

// Telemetry severed: remote distributed-tracing export removed.
// Tracing now writes to stdout only and never connects to a remote collector.
pub fn init_tracing() {
    if tracing::dispatcher::has_been_set() {
        return;
    }

    let env_filter = env::var("RUST_LOG").unwrap_or_else(|_| "info,sqlx=warn".to_string());
    let fmt_layer = fmt::layer()
        .json()
        .with_target(false)
        .with_span_events(FmtSpan::CLOSE)
        .boxed();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(env_filter))
        .with(ErrorLayer::default())
        .with(fmt_layer)
        .with(utils::observability::tracing_noop_layer())
        .init();

    tracing::info!("Tracing initialized (stdout only)");
}

pub fn configure_user_scope(user_id: uuid::Uuid, username: Option<&str>, email: Option<&str>) {
    utils::observability::configure_user_scope(&user_id.to_string(), username, email);
}
