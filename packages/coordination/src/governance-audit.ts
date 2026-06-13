// Governance audit trail (slice 3.5-A.2c.1) — the append-only, org-scoped record of credential
// management actions (set / delete). A narrow seam (kept off the big CoordinationStore so the many
// fakes don't ripple, mirroring VendorCredentialStore): the credential API records each successful
// mutation here and lists the trail for an admin read endpoint.
//
// What is recorded: WHO (actor_user_id), WHEN (at), WHICH provider (target), and the key
// FINGERPRINT + status (payload). NEVER the key itself — the plaintext is sealed+stored in
// org_vendor_credential and must never reach this trail.

/** One governance audit row, projected for the read endpoint. */
export interface GovernanceAuditEvent {
  id: string;
  actorUserId: string;
  action: string;
  target: string | null;
  payload: Record<string, unknown>;
  at: string;
}

/** The org-scoped governance audit seam. `recordGovernanceAudit` appends one row; `listGovernanceAudit`
 *  returns the org's trail newest-first. Both are org-scoped by construction — the read never crosses
 *  tenants, and `payload` NEVER carries a raw key. */
export interface GovernanceAuditSink {
  recordGovernanceAudit(
    orgId: string,
    e: { actorUserId: string; action: string; target?: string; payload?: Record<string, unknown> }
  ): Promise<void>;
  listGovernanceAudit(orgId: string, opts?: { limit?: number }): Promise<GovernanceAuditEvent[]>;
}
