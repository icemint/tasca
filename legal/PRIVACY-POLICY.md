# Privacy Policy

**Tasca**

**Effective date:** June 1, 2026
**Last updated:** June 1, 2026

> **NOT LEGAL ADVICE — REVIEW BEFORE PUBLISHING.** This document is a drafting starting point generated from a template and the *mill-deterrent-pack* clause library. It has **not** been reviewed by a licensed attorney. The entity, contact, and date fields are filled, but two items still require your input before publishing: the tracking-technology disclosure in Section 6 **must be reconciled against an actual audit** of what tasca.dev really collects (naming a tracker you do not use — or omitting one you do — undermines the disclosure), and the CCPA/CPRA disclosures in Section 11.1 must be completed. Counsel review is still required. See `INTEGRATION-NOTES.md`.

---

## 1. Who we are and what this Policy covers

This Privacy Policy explains how ICEMINT, LLC ("**Company**," "**we**," "**us**") collects, uses, shares, and protects information in connection with the Tasca hosted service at tasca.dev and associated applications, APIs, and websites (collectively, the "**Service**"). It is incorporated into and governed by our Terms of Service.

**Hosted vs. self-hosted.** This Policy describes the **hosted** Service that Company operates. If you deploy Tasca yourself (self-hosted), you are the operator and data controller for that instance, you determine what data it processes, and this Policy does not govern your instance. The Tasca application is designed to operate without sending product telemetry to Company; see Section 6.

## 2. Information we collect

We collect the following categories in operating the hosted Service:

**Account and identity data.** Name, email address, hashed password, and authentication state. Where you sign in via a third-party identity provider (e.g., GitHub or Google) using OAuth, we receive the profile information that provider returns and authorization tokens, which are stored encrypted.

**Organization and project data.** Organizations, projects, issues/tickets, comments, tags, sprints, statuses, agent configurations, assignments, and activity/audit-timeline records generated as you and your team use the Service.

**Connected-credential data.** Third-party credentials and keys you choose to connect — including model-provider API keys (e.g., Anthropic Console API keys) and source-control authorizations. These are stored encrypted and used to provide the features you enable.

**Code and execution data.** Repository content, worktrees, diffs, pull-request metadata, prompts, and AI agent outputs processed to run agent tasks you initiate.

**Integration data.** Information exchanged with services you connect (e.g., GitHub app installations, webhooks, pull-request and review events).

**Support and communications.** Information you provide when you contact us.

**Website/technical data.** Basic technical information necessary to deliver the website and Service (e.g., IP address, device and browser information, and request logs), as described in Section 6.

## 3. How we use information

We use information to: provide, operate, secure, and improve the Service; authenticate users and protect accounts; route and execute agent tasks you initiate; integrate with services you connect; provide support; comply with law; and enforce our Terms. We process Customer Content only to provide the Service to you and as you direct, or as required by law.

## 4. How we share information

We share information only as follows: (a) with **service providers and infrastructure vendors** that host or support the Service, under contractual confidentiality and security obligations; (b) with **AI model providers and other third-party services you connect or direct us to use** — for example, when the PM-assistant or a cloud worker agent sends task content to a model provider's API under your configured key, that content is transmitted to and processed by that provider under its terms; (c) with **source-control and identity providers** you connect; (d) in connection with a **merger, acquisition, or sale of assets**, subject to this Policy; and (e) where **required by law** or to protect rights, safety, and the security of the Service. **We do not sell your personal information.**

## 5. International data transfers

The Service is operated from, and information may be processed in, the United States and other countries where we or our service providers operate. If you access the Service from outside the United States, you understand that your information may be transferred to and processed in countries whose data-protection laws may differ from those of your country. Where applicable law requires a transfer mechanism, we will rely on a lawful mechanism. **International users:** see Section 10.

## 6. Tracking technologies and consent

> **PUBLISHER ACTION REQUIRED — AUDIT BEFORE PUBLISHING.** Per the product requirements, the Tasca **application** is built to strip third-party analytics and telemetry (e.g., it does not ship PostHog or Sentry). Do **not** list trackers the application does not actually use. The list below is a template for the **tasca.dev website/marketing/documentation properties only** — fill it in from a real audit of your tag configuration (for example, documentation-host analytics, cookie/consent tooling, or marketing pixels if you add them). If a property uses no tracking technologies, say so plainly instead of listing categories.

The Tasca **application** does not embed third-party advertising, analytics, or session-replay tracking technologies and does not send product-usage telemetry to Company. We process only the technical request data necessary to operate and secure the Service (Section 2).

Our **website and documentation properties** at tasca.dev may use the following categories of tracking technologies. The technologies in current use include, without limitation:

- **Analytics:** [name any web/docs analytics tool actually in use, or state "none"].
- **Advertising and attribution:** [name any advertising or attribution pixels in use, or state "none"].
- **Session recording / replay:** [name any session-replay tool in use, or omit].
- **Heat-mapping:** [name any heat-mapping tool in use, or omit].
- **Email and CRM tracking:** [name any email/CRM tracking pixels in use, or omit].

Where used, these technologies may collect information about your interactions with the website, including page views, navigation patterns, click events, device and browser information, IP address, approximate location derived from IP, and referrer information, and may transmit it to the third-party providers named above, in some cases on servers outside your country of residence.

**Consent through use.** By accessing the website and continuing to use it, you acknowledge and consent to the use of these tracking technologies and to the collection, transmission, and processing of data described in this Policy. If you do not consent, do not use the website. *(See Section 10 — this continued-use consent model does not apply to users in jurisdictions that require opt-in consent.)*

**Optional opt-outs.** You may control or limit certain optional tracking through standard browser controls (including cookie blocking and Do Not Track signals); our cookie-preferences interface where available at [URL or in-product location]; and the opt-out mechanisms made available by the third-party providers we use, including [provider opt-out links]. Limiting optional tracking does not affect your ability to use the Service.

## 7. Data retention and security

We retain information for as long as needed to provide the Service, comply with legal obligations, resolve disputes, and enforce agreements, after which we delete or de-identify it. We use technical and organizational safeguards — including encryption of stored credentials and API keys and access controls — designed to protect information. No method of transmission or storage is completely secure, and we cannot guarantee absolute security.

## 8. Your choices and rights

You may access and update account information, disconnect integrations, revoke connected credentials, and request deletion of your account by contacting privacy@tasca.dev or using in-product controls where available. Depending on your jurisdiction, you may have additional rights described in Sections 10 and 11.

## 9. Disputes regarding data handling

Any dispute, claim, or controversy arising under or relating to the collection, use, sharing, processing, or retention of data under this Policy is governed by the **dispute-resolution provisions of the Terms of Service** — including the pre-dispute notice requirements, informal-resolution requirements, arbitration agreement, class-action waiver, governing law, and venue (Terms Section 14). By using the Service, you agree that any such dispute will proceed in accordance with those provisions and will not be brought as a class, collective, consolidated, or representative action, except as limited by Section 11 (California) and Section 10 (international users) below or by any other non-waivable right under applicable law.

## 10. Substantiation of data-handling claims

If you believe your data has been collected, used, shared, or processed in violation of this Policy or applicable law, you must provide us, as part of your pre-dispute notice under the Terms, with all of the following:

(a) a complete, unedited copy of the data forming the basis of your claim;
(b) a detailed written explanation specifying the nature of the alleged violation, the date(s) on which it occurred, the URLs accessed, the device and browser used, and the IP address(es) used to access the Service if known;
(c) the legal theory or theories on which the claim is based; and
(d) a description of the harm alleged.

This requirement is intended to enable a meaningful investigation of any alleged violation and shall not be construed to limit any rights you have under applicable law.

## 11. Jurisdiction-specific rights

Depending on where you live, you may have additional rights regarding your information. Exercise of these rights is governed by the procedures in the applicable sub-section below, not by Section 10.

### 11.1 California residents (CCPA/CPRA)

> **PUBLISHER ACTION REQUIRED.** Complete this section based on your actual data practices. Required disclosures typically include the categories of personal information collected, sources, business/commercial purposes, categories disclosed, and whether you "sell" or "share" personal information (as defined by the CCPA/CPRA).

If you are a California resident, you may have the right to: know the categories and specific pieces of personal information we collect; access and delete personal information; correct inaccurate personal information; and opt out of "sale" or "sharing" of personal information as those terms are defined under the CCPA/CPRA. **We do not sell your personal information**, and we do not "share" it for cross-context behavioral advertising [confirm and adjust based on your audit]. We will not discriminate against you for exercising these rights. To exercise a right, contact privacy@tasca.dev; we will verify your request as required by law. You may use an authorized agent. As noted in Terms Section 14.12, certain aggressive dispute-resolution provisions may be limited or unenforceable for California users, and nothing here waives a non-waivable California right, including the right to seek public injunctive relief.

### 11.2 Other international users (e.g., Canada, Australia)

If you access the Service from outside the United States, additional rights may apply under your local law. We will honor applicable rights to access, correct, or delete personal information as required by the law governing your data. The continued-use consent model in Section 6 may not satisfy your local consent requirements; where your law requires opt-in consent for certain processing or tracking, we will rely on opt-in consent for those activities. To make a request or ask which framework applies to you, contact privacy@tasca.dev.

> **Note on the EU/UK (publisher):** This Policy is written for a U.S.-centric, U.S.-and-international (non-EU/UK) user base, per your configuration. The dispute-resolution and continued-use-consent framing is **not** a valid approach for EU/EEA or UK consumers (GDPR/UK-GDPR require opt-in consent and broadly invalidate pre-dispute consumer arbitration). If you later acquire meaningful EU/UK users, add GDPR/UK-GDPR sections and obtain local counsel before relying on this Policy for them.

## 12. Children's privacy

The Service is not directed to children under 18, and we do not knowingly collect personal information from them. If you believe a child has provided us personal information, contact privacy@tasca.dev and we will take appropriate steps to delete it.

## 13. Changes to this Policy

We may update this Policy from time to time. We will post the updated effective date and, for material changes, provide reasonable notice. For users in jurisdictions requiring opt-in consent to material changes, we will obtain consent where required.

## 14. Contact us

Questions or requests regarding this Policy or your information: privacy@tasca.dev / 30 N Gould St, Ste R, Sheridan, WY 82801.

---

> **Send the revised document to counsel for jurisdiction-specific review before publishing.**
