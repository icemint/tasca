pub mod client;
pub mod error;
pub mod fragment;
pub mod host;
pub mod peer;
pub mod proxy;
pub mod signaling;

pub use client::{WebRtcClient, WebRtcClientError, WsConnection, WsOpenResult};
pub use error::WebRtcError;
pub use host::WebRtcHost;
pub use proxy::{
    DataChannelMessage, DataChannelRequest, DataChannelResponse, DataChannelWsStream, WsClose,
    WsError, WsFrame, WsOpen, WsOpened,
};
pub use signaling::{IceCandidate, SdpAnswer, SdpOffer};

/// ICE servers (STUN/TURN) for WebRTC, read from the `TASCA_STUN_URLS`
/// environment variable (comma-separated). Empty/unset means no STUN server
/// (local-network ICE only).
///
/// The upstream hardcoded third-party STUN default (`stun.l.google.com`) has
/// been severed: by default this fork makes no outbound STUN request. Self-host
/// deployments that need NAT traversal across networks can set their own
/// STUN/TURN URLs via `TASCA_STUN_URLS`.
pub(crate) fn ice_servers_from_env() -> Vec<webrtc::ice_transport::ice_server::RTCIceServer> {
    use webrtc::ice_transport::ice_server::RTCIceServer;

    match std::env::var("TASCA_STUN_URLS") {
        Ok(raw) if !raw.trim().is_empty() => {
            let urls: Vec<String> = raw
                .split(',')
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
                .collect();
            if urls.is_empty() {
                vec![]
            } else {
                vec![RTCIceServer {
                    urls,
                    ..Default::default()
                }]
            }
        }
        _ => vec![],
    }
}

/// Build a webrtc API restricted to UDP4 (IPv4 only).
///
/// Without this, the ICE agent tries IPv6 STUN which times out on most
/// networks and blocks ICE gathering.
fn build_api() -> webrtc::api::API {
    use webrtc::api::setting_engine::SettingEngine;
    use webrtc_ice::network_type::NetworkType;

    let mut se = SettingEngine::default();
    se.set_network_types(vec![NetworkType::Udp4]);
    webrtc::api::APIBuilder::new()
        .with_setting_engine(se)
        .build()
}
