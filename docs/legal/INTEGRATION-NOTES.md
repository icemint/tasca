# Tasca — Legal Docs: Integration Notes & Counsel Handoff

Companion to `TERMS-OF-SERVICE.md` and `PRIVACY-POLICY.md`. Structured per the *mill-deterrent-pack* integration protocol (`AGENTS.md`).

**Source of anti-litigation-mill clauses:** `github.com/mindheadllc/mill-deterrent-pack` (MIT-licensed clause library; "not legal advice"). These documents are **drafts for counsel review**, not finished legal documents.

> **Updated for the product pivot (Tasca-PRD-v1.0-FINAL + Design Brief v1.0).** Tasca is now an **AI agent workforce platform** — a roster of named, multi-vendor AI agents (Anthropic/OpenAI/BYO-local) given **native identities** inside Shortcut, GitHub, and Linear, routed by the capability/tier engine, executing on Company-coordinated runners or on your own infrastructure over SSH. The kanban/Vibe-Kanban product and the Jira adapter are dropped; the execution layer is now a fork of **Emdash (Apache-2.0)**. Both documents were revised accordingly. **Fathom Analytics** is now named in Privacy §6, which resolves the previously-open tracker placeholder.

---

## Your configuration (from intake)

| Question | Your answer | How it shaped the drafts |
|---|---|---|
| Governing law / venue | Wyoming; venue Sheridan, WY | Inserted throughout Terms §14.10, §14.8, §14.12. |
| Risk tier | Full stack (Tier 1 + 2 + 3) | All clauses included, including the aggressive Tier 3 ones, with severance and California safeguards. |
| User geography | US + California + other international (no EU/UK) | Added CCPA/CPRA section, California carve-back in Terms §14.12, international-users section, and an EU/UK "not covered — add later" flag. |
| Format | Markdown | Delivered as `.md`. |

---

## Threat-Model Fit

**Partial — and the pivot makes it more so.** The mill-deterrent-pack is built for **consumer-facing** services (e-commerce, consumer SaaS, content/lead-gen) hit with high-volume, statutory-damages demand letters (CIPA, ADA, BIPA, session-replay, pixel-tracking). Post-pivot, Tasca is an **enterprise developer-infrastructure platform** ("Fortune-500-grade clients are in scope," per the design brief) — even further from the consumer profile the pack targets; the pack explicitly states it is "not for B2B contracts."

What this means:
- The **class-action waiver, notice/substantiation requirements, choice of law, and accurate tracking disclosure** (Tier 1) remain sensible for almost any online service and are worth keeping.
- **Pixel/session-replay deterrent value is essentially nil for you.** The control plane embeds no analytics, and the website uses **Fathom — cookieless, no personal data, no cross-site tracking**. The tracking-disclosure section's job here is simply to state that accurately (which it now does), not to fend off pixel-tracking mills. An honest "we use cookieless analytics and no ad pixels" disclosure is itself a strong defense against CIPA/session-replay/pixel theories.
- The **aggressive Tier 3 clauses** are a deterrent posture, but their unconscionability exposure is highest in the consumer context the pack targets — and you have **California users**. For an enterprise B2B tool sold under signed agreements, counsel may reasonably prefer a B2B master-services-agreement structure over a consumer-arbitration posture. (You chose full stack; it's in. Flagging the tradeoff per protocol.)
- **New for enterprise:** Fortune-500 customers will likely require a **Data Processing Agreement (DPA)** and a security/sub-processor exhibit (your sub-processors now include Anthropic, OpenAI, Shortcut, GitHub, Linear, Fathom, and your hosting/infra vendors). That's a separate document counsel should prepare; it is **not** part of these two drafts.

## Risk Tier Selected

**Full stack — Tier 1 + Tier 2 + Tier 3**, as you requested.

## Provisions Included

**Tier 1 (durable, all users):**
- Pre-dispute notice-content requirements — Terms §14.2
- Claim-substantiation requirement — Privacy §10
- Class-action waiver (non-severable from arbitration agreement) — Terms §14.7
- Choice of law and venue — Terms §14.10
- Tracking-technology consent / disclosure — Privacy §6
- Disputes-cross-reference (Privacy → Terms) — Privacy §9

**Tier 2 (jurisdiction-sensitive):**
- 60-day pre-arbitration informal-resolution period — Terms §14.3
- Mandatory two principal-level meetings (video allowed, rep/counsel may attend) — Terms §14.3
- Fee-arrangement and prior-claims disclosure, framed as anti-fraud screening — Terms §14.2(k)–(l)

**Tier 3 (aggressive; meaningful severance risk):**
- Pre-merits good-faith / frivolousness review — Terms §14.5
- Claimant-pays-arbitration-costs (capped by provider consumer rules) — Terms §14.6
- Bad-faith full-cost reimbursement on arbitrator finding — Terms §14.5

**Load-bearing safeguards:**
- Severability with class-waiver carve-out (the *Concepcion* pattern) — Terms §14.7, §14.11
- "To the maximum extent permitted by applicable law / provider rules" qualifiers on every Tier 3 mechanic, so they bend rather than break.
- California carve-back — Terms §14.12; Privacy §11.1.
- IP / injunctive-relief and small-claims carve-outs from arbitration — Terms §14.8.

## Provisions Skipped / Adjusted

- **EU/UK GDPR sections — not included.** Per your "no EU/UK" answer. Flagged in Privacy §11.2 note: add before serving EU/UK consumers.
- **Tracking disclosure — now resolved with Fathom.** Privacy §6 states the control plane embeds no analytics and the website uses Fathom (cookieless, aggregate, no ad/replay/heat-map/email pixels). This is accurate and is itself a defense against pixel/session-replay theories — provided it stays true. Re-audit quarterly; if you ever add another tool, name it.

## Conflicts with existing documents

You provided **no existing TOS or Privacy Policy**, so these are net-new drafts rather than a merge. If you already have legal docs elsewhere (e.g., a prior tasca.dev policy), reconcile: defined terms ("Service," "Agreement"), any existing arbitration/governing-law clause, and your acceptance UX must be made consistent. Do not run two conflicting policies.

## Placeholders — status

**Completed (filled in both documents):**

| Item | Value |
|---|---|
| Operating entity | ICEMINT, LLC |
| Governing law | State of Wyoming |
| Venue | Sheridan, Wyoming |
| Arbitration administrator | American Arbitration Association (AAA), Consumer Arbitration Rules |
| Notice address | 30 N Gould St, Ste R, Sheridan, WY 82801 |
| Contacts | legal@tasca.dev / privacy@tasca.dev |
| Effective / last updated | June 1, 2026 |

**Resolved:**

| Item | Where | Value |
|---|---|---|
| Website/docs analytics | Privacy §6 | **Fathom Analytics** (cookieless, aggregate, no ad/replay/heat-map/email pixels). No banner needed. |
| Cookies disclosure | Privacy §6 | Short **"Cookies and essential storage"** subsection — strictly-necessary cookies only (login/session/prefs). No banner. |
| CCPA/CPRA disclosure | Privacy §11.1 | **Complete** — statutory-category table, SPI (account/connection credentials), sources, purposes, third parties, retention. Based on: no paid plans, **no model training on customer content**, transactional email only, no sale/share. |

**Still open — your input or counsel work:**

| Item | Where | What to do |
|---|---|---|
| Fathom description check + DPA | Privacy §6 | Verify against Fathom's current docs; obtain Fathom's DPA if you want a processor agreement. |
| Commercial-info / payment processor | Privacy §11.1 (cat. D) | When paid plans launch, flip category D to "Yes" and add the processor (e.g., Stripe). Noted inline. |
| Enterprise DPA + sub-processor list | separate doc | For Fortune-500 customers — counsel to prepare; not part of these two drafts. |
| Self-host/SSH data-residency posture | Terms §2, Privacy §5 | Confirm "execution on your infrastructure" framing matches final architecture. |

## Caveats & counsel-review items

1. **Acceptance UX is decisive.** None of §14 binds users unless your signup flow captures enforceable consent. Use **clickwrap** (explicit "I agree" before entering the Service) with a stored, timestamped record. Confirm before relying on these terms.
2. **California exposure + Tier 3.** §14.5/§14.6 (pre-merits review, claimant-pays, bad-faith reimbursement) are most exposed under CA law (CCP §§ 1281.97–1281.99, *McGill*, PAGA). Have **California counsel** confirm §14.12 adequately preserves non-waivable rights.
3. **Wyoming governing law (set).** Wyoming is business/LLC-friendly and not a consumer-hostile arbitration jurisdiction, so the Tier 3 clauses face lower in-state strike risk than in California. **Caveat:** a Wyoming choice-of-law clause does not always defeat the consumer-protection law of a customer's home state — courts (especially California) can apply their own fundamental public policy to their residents regardless of the chosen law. That's exactly why the §14.12 California carve-back is in the draft. Confirm ICEMINT, LLC is in good standing in WY and that the Sheridan venue is genuinely tied to the business.
4. **B2B vs. consumer framing.** If Tasca is sold to organizations under signed order forms, counsel may prefer a B2B master-agreement structure over a consumer-arbitration posture; the two have different enforceability dynamics.
5. **Tracking disclosure accuracy.** Keep Privacy §6 reconciled with reality and re-audit quarterly. An inaccurate disclosure is worse than a generic one.
6. **Self-host boundary.** The drafts state these govern the Company-operated hosted Service only and that self-hosters are their own controllers. Confirm this matches your actual offering and your open-source `LICENSE`/`NOTICE`.
7. **Do not modify mid-claim.** If you ever receive an active demand letter, **stop** — do not edit these documents while a matter is live; engage counsel first (per the pack's own guidance).

## Acknowledged override

Per protocol: you selected the **full Tier 3 stack** despite the elevated severance risk and your California user base, and despite the partial (B2B) threat-model fit. That choice is reflected in the drafts, with the safeguards above. This is documented here as your informed selection.

---

> **Send the revised documents to counsel for jurisdiction-specific review before publishing.**

**Sources:** [mill-deterrent-pack (README, AGENTS.md, enforceability-risk.md, TOS & Privacy templates)](https://github.com/mindheadllc/mill-deterrent-pack); Tasca `PRD.md` (uploaded).
