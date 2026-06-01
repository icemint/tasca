# Tasca — Legal Docs: Integration Notes & Counsel Handoff

Companion to `TERMS-OF-SERVICE.md` and `PRIVACY-POLICY.md`. Structured per the *mill-deterrent-pack* integration protocol (`AGENTS.md`).

**Source of anti-litigation-mill clauses:** `github.com/mindheadllc/mill-deterrent-pack` (MIT-licensed clause library; "not legal advice"). These documents are **drafts for counsel review**, not finished legal documents.

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

**Partial.** The mill-deterrent-pack is built for **consumer-facing** services (e-commerce, consumer SaaS, content/lead-gen) that get hit with high-volume, statutory-damages demand letters (CIPA, ADA, BIPA, session-replay, pixel-tracking). Tasca reads as a **developer/team (largely B2B) tool** — the pack explicitly states it is "not for B2B contracts."

What this means:
- The **class-action waiver, notice/substantiation requirements, choice of law, and accurate tracking disclosure** (Tier 1) are sensible for almost any online service and are worth keeping.
- The **pixel/session-replay deterrent value is low for you** *if* your product genuinely ships no trackers (your PRD says telemetry/PostHog/Sentry are cut). The tracking-disclosure clause's main job here is to keep your public **website/docs** disclosure accurate, not to fend off pixel-tracking mills.
- The **aggressive Tier 3 clauses** are a deterrent posture you can adopt, but their unconscionability exposure is highest in exactly the consumer context the pack targets — and you have **California users**, the most hostile jurisdiction for them. Consider whether full-stack is proportionate for a developer tool, or whether Tier 1+2 would serve you with less strike risk. (You chose full stack; it's in. Flagging the tradeoff per protocol.)

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
- **Naming specific trackers — left as an audit placeholder.** Your product strips telemetry, so asserting trackers would be inaccurate and would *undermine* the disclosure (the pack is explicit about this). Privacy §6 says the application sends no telemetry and leaves the website/docs tracker list for you to fill from a real audit.

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

**Still open — require your input before publishing:**

| Item | Where | What to do |
|---|---|---|
| Website/docs tracker list | Privacy §6 | Fill from a real audit of tasca.dev website/docs, or state "none." |
| Cookie opt-out links / preferences URL | Privacy §6 | Add real opt-out links and preferences-UI location, or remove if no trackers. |
| CCPA/CPRA disclosures | Privacy §11.1 | Categories collected/disclosed; confirm no "sale"/"share." |

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
