# Tasca — Shortcut Integration: Kickoff Confirmations Brief

**Purpose:** the questions to confirm with the Shortcut team **before** building the adapter *intake* (PRD §5.1/§10; scaffold §4.3 — gates build-step 6). The `PlatformAdapter` interface and the `@tasca/identity` primitive proceed independently; **webhook intake + agent-user provisioning are held until these are answered.**

**Context for the Shortcut team:** Tasca is an AI agent workforce platform — a roster of named AI "employees" (e.g. *Elvis* = Claude) that need **native Shortcut identities** (agent-users), receive Stories assigned to them, work the code, and report status back as themselves. Shortcut is our **first** adapter.

---

## 1. Surface split — MCP server vs Agent API

Our working model is **two surfaces with different jobs**:

| Surface | Role | Used when |
|---|---|---|
| **`@shortcut/mcp` (MCP server)** | read/write **tooling** — the agent's hands for querying/mutating Stories, comments, etc. | *during* a run (the executing agent operates on Shortcut data) |
| **Agent API** | **identity + intake** — provisioning the native agent-user, receiving the assignment webhook | the agent *is* a teammate and *gets handed* work |

**Confirm:**
- Is this division correct? Specifically, which surface owns each of: (a) creating/provisioning an agent-user, (b) the "assigned to agent" webhook, (c) **status-back** (comment + workflow-state change + PR link)?
- Is `@shortcut/mcp` intended for in-run agent tool-use, and the Agent API for identity/lifecycle? Any overlap or deprecation we should know?

## 2. Token ↔ per-agent identity — **the one real blocker**

The `Shortcut-Token` is user- and workspace-specific (PRD §5.1). If a workspace yields effectively **one** service token, how does each roster agent (Elvis, Mira, …) act as a **distinct** agent-user — separate `owner_ids`, separate comment authorship, separate audit trail?

Candidate shapes (we need to know which Shortcut supports **today**):
- **(a)** one agent-user **per** Tasca agent, each with its own token;
- **(b)** one workspace service token that can **act-as** a chosen agent-user per call (impersonation/delegation);
- **(c)** a hybrid.

**Confirm:**
- Which model is supported now?
- Is **programmatic agent-user creation** available (an endpoint), or is it admin-UI-only ("Configure Agent Users" in Integrations)?
- Agent API **SDK** availability / timeline?

> Tasca's `@tasca/identity` already absorbs whichever answer: `identity_binding.credential_ref` is **per-binding** and the internal `principal_id` is stable across token rotation — so the resolution is a binding-layer detail, not a re-architecture. We just need the shape locked before writing provisioning + intake.

## 3. Assignment-webhook contract

To build intake we need the exact **"assigned to agent"** event:
- the outgoing webhook signature scheme (we expect **HMAC-SHA-256** via a `Payload-Signature` header),
- the `actions[]` payload shape when a Story's `owner_ids` gains an agent-user, and
- the **@mention-in-comment** event shape.

(We'll validate inbound payloads against a Zod schema, so a later contract tweak is a one-file edit — but we need the v1 shape.)

## 4. What we build once confirmed (not before)

`@tasca/adapters` Shortcut impl: `provisionIdentity` (per the confirmed token model) · `verifyWebhook` (HMAC) + `parseEvent` (the confirmed payload) → normalized `AdapterEvent` · `postStatus` (comment + workflow-state + PR link via the confirmed surface).

## Status

- **Held (gated):** Shortcut webhook intake + agent-user provisioning — pending §1/§2/§3 answers.
- **Proceeding now (ungated):** the `PlatformAdapter` interface seam and `@tasca/identity` (which is built precisely to make the §2 token answer a drop-in).
