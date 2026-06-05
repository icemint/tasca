# Terms of Service

**Tasca**

**Effective date:** June 1, 2026
**Last updated:** June 1, 2026

## 1. Agreement to these Terms

These Terms of Service ("**Terms**" or "**Agreement**") are a binding contract between you ("**you**," "**Customer**," or "**User**") and ICEMINT, LLC ("**Company**," "**we**," "**us**," or "**our**"), governing your access to and use of the Tasca hosted service available at tasca.dev and any associated applications, APIs, integrations, and documentation (collectively, the "**Service**").

By creating an account, clicking "I agree" (or a similar control), or accessing or using the Service, you agree to these Terms and to our Privacy Policy, which is incorporated by reference. **If you do not agree, do not access or use the Service.**

If you accept these Terms on behalf of an organization, you represent that you have authority to bind that organization, and "you" refers to that organization.

> **Acceptance UX note (for the publisher, delete before publishing):** The dispute-resolution provisions below bind users only to the extent your acceptance flow creates enforceable consent. **Clickwrap** (an explicit checkbox or "I agree" button shown before the user enters the Service) is materially stronger than **browsewrap** (continued use as implied consent). Confirm your signup flow records verifiable consent.

## 2. The Service

Tasca is an AI agent workforce platform. You assemble a roster of named AI agents ("**agents**"), each provisioned with a native identity inside the third-party tools your team already uses (such as Shortcut, GitHub, and Linear), and Tasca's capability-aware routing engine assigns tasks to the agent best suited to perform them. Agents may receive assigned tickets, work code in isolated git worktrees, open and update pull requests, respond to reviews and webhooks, and operate across multiple projects on a continuous basis. The Service may include the roster control plane, the routing engine, per-platform identity provisioning, execution coordination, and related features.

**Execution on your infrastructure.** Portions of agent execution may run on third-party platforms you connect or on infrastructure you provide or authorize — for example, your own host or GPU machine reached over SSH, or local AI models you operate. Where execution occurs on a third-party platform or on infrastructure you control, you are the operator and controller of that platform or infrastructure and of the data on it, and its own terms (and your own administration) govern it. These Terms govern only the Company-operated hosted Service at tasca.dev (this website, the control plane, the routing engine, and any APIs we operate); they do not govern third-party tools, model providers, or your own infrastructure.

## 3. Eligibility and accounts

You must be at least 18 years old and capable of forming a binding contract to use the Service. You are responsible for: (a) all activity under your account; (b) maintaining the confidentiality of your credentials; and (c) ensuring that everyone who uses your account or organization complies with these Terms. Notify us promptly at legal@tasca.dev of any unauthorized use.

## 4. Customer responsibilities for AI agents, credentials, and code

The Service orchestrates AI coding agents that execute tasks against repositories and may take actions on connected systems. You acknowledge and agree that:

(a) **You direct the agents.** You are responsible for the tickets, prompts, configurations, repositories, and connected systems you provide to the Service, and for reviewing all agent output (including code and pull requests) before relying on it, merging it, or deploying it. AI output may be inaccurate, incomplete, or insecure.

(b) **Your credentials, API keys, and infrastructure access.** You are responsible for any third-party credentials, API keys, OAuth authorizations, platform tokens, and infrastructure access you connect to the Service — including, without limitation, AI model-provider keys (such as Anthropic and OpenAI keys), local-model endpoints, Shortcut, GitHub, and Linear authorizations, and any SSH or host credentials you provide for remote execution — and for complying with the terms of those third parties. You must use model-provider and platform credentials that are validly licensed to your organization for automated and agent use; subscription credentials must not be used in violation of the applicable provider's policies.

(c) **Your content.** "**Customer Content**" means code, tickets, comments, configurations, data, and other materials you or your users submit to or generate through the Service. As between you and Company, you retain all rights in Customer Content. You grant Company a limited, non-exclusive license to host, process, transmit, and display Customer Content solely to operate and provide the Service.

(d) **Rights and compliance.** You represent that you have all rights necessary to submit Customer Content and to authorize the Service to act on the connected platforms, repositories, and systems, and that your use complies with applicable law and any third-party terms.

(e) **Native agent identities.** You authorize Company, on your behalf, to provision, configure, and operate native agent identities within the third-party workspaces you connect (for example, Shortcut agent users, per-repository GitHub Apps, and Linear app users), solely to provide the Service. You represent that you have authority to authorize the creation and operation of such identities in those workspaces, that doing so complies with the applicable third-party terms, and that — where a connected platform requires a human of record or accountable owner behind a delegated agent — you will designate one.

## 5. Acceptable use

You agree not to, and not to permit any user or agent to:

(a) use the Service to develop, host, or distribute malware, exploits, or other malicious code, or to gain unauthorized access to any system;
(b) violate, infringe, or misappropriate the intellectual property, privacy, or other rights of any third party;
(c) use the Service in violation of applicable law or applicable export controls or sanctions;
(d) interfere with, disrupt, or place undue load on the Service or attempt to circumvent its security, rate limits, sandboxing, or access controls;
(e) reverse engineer or attempt to extract source code from Company-operated services except to the extent this restriction is prohibited by law or expressly permitted by an applicable open-source license; or
(f) submit, as an external or guest participant, instructions intended to trigger code execution without internal authorization, or otherwise attempt to defeat the Service's trust-tier and sandboxing controls.

We may suspend or limit access to protect the Service, our users, or third parties, or to address suspected violations.

## 6. Third-party services and integrations

The Service integrates with third-party services (including, without limitation, project- and issue-tracking platforms such as Shortcut, GitHub, and Linear; source-control providers; identity providers; and AI model providers such as Anthropic and OpenAI). Your use of those services is governed by their terms and privacy practices, not these Terms. Company is not responsible for third-party services and does not guarantee their availability, security, or output.

## 7. Fees

If the Service or any portion of it is offered for a fee, you agree to the pricing and payment terms presented at the point of purchase. Except as required by law or expressly stated, fees are non-refundable. We may change fees prospectively on reasonable notice. You are responsible for taxes other than Company's income taxes. Charges incurred with third-party model or infrastructure providers under your own accounts are your responsibility.

## 8. Intellectual property

The Service, including its software, design, and documentation (excluding Customer Content and excluding any third-party or open-source components governed by their own licenses), is owned by Company or its licensors and is protected by intellectual-property laws. Subject to these Terms, Company grants you a limited, non-exclusive, non-transferable, revocable right to access and use the hosted Service. No rights are granted except as expressly stated. Feedback you provide may be used by Company without restriction or obligation.

## 9. Open-source components

The Service incorporates open-source software — including a fork of the Emdash execution layer (Apache-2.0) — which remains subject to its respective licenses (see the applicable `LICENSE` and `NOTICE` files). Nothing in these Terms limits your rights under, or grants rights inconsistent with, those open-source licenses. In the event of a conflict between these Terms and an applicable open-source license with respect to that component, the open-source license governs that component.

## 10. Disclaimers

THE SERVICE AND ALL AI AGENT OUTPUT ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WITHOUT LIMITATION IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. COMPANY DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE, OR THAT AI OUTPUT WILL BE ACCURATE, COMPLETE, OR SUITABLE FOR ANY PURPOSE. YOU ARE SOLELY RESPONSIBLE FOR REVIEWING AND TESTING ALL AGENT-GENERATED CODE BEFORE USE. Some jurisdictions do not allow certain warranty exclusions, so some of the above may not apply to you.

## 11. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, COMPANY AND ITS AFFILIATES, OFFICERS, EMPLOYEES, AND SUPPLIERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS, EVEN IF ADVISED OF THE POSSIBILITY. COMPANY'S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID COMPANY FOR THE SERVICE IN THE TWELVE (12) MONTHS BEFORE THE EVENT GIVING RISE TO THE LIABILITY, OR (B) ONE HUNDRED U.S. DOLLARS ($100). Some jurisdictions do not allow certain limitations, so some of the above may not apply to you.

## 12. Indemnification

You will indemnify and hold harmless Company and its affiliates from and against any third-party claims, damages, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or relating to: (a) your Customer Content; (b) your use of the Service; (c) your violation of these Terms or applicable law; or (d) your violation of any third-party right, including in connection with repositories or systems you connect to the Service.

## 13. Term, suspension, and termination

These Terms apply while you use the Service. You may stop using the Service at any time. We may suspend or terminate your access if you breach these Terms, if required by law, or to protect the Service or others. Upon termination, the rights granted to you cease; provisions that by their nature should survive (including Sections 4(c), 8, 10, 11, 12, 14, and 15) survive.

## 14. Dispute Resolution

> **The following Section reflects the full Tier 1+2+3 stack from the mill-deterrent-pack, including its most aggressive (and most severance-exposed) provisions — Sections 14.5, the Tier 3 portion of 14.6, and the bad-faith reimbursement in 14.5. These are designed primarily as a deterrent against high-volume serial filers and carry meaningful risk of being struck (especially as to California consumers) under unconscionability review. Counsel review is essential. See `INTEGRATION-NOTES.md`.**

### 14.1 Application of this Section

This Section governs any dispute, claim, or controversy arising under or relating to these Terms, the Service, or any related communications or interactions between you and Company (each, a "**Dispute**"). This Section applies regardless of whether the Dispute sounds in contract, tort, statute, or any other legal theory. "**Claimant**" means the party asserting a Dispute; "**Respondent**" means the party against whom a Dispute is asserted.

### 14.2 Pre-Dispute notice requirements

Before initiating any formal dispute-resolution process under this Section, Claimant shall send Respondent a detailed written notice of the Dispute by email to legal@tasca.dev with delivery confirmation, or by certified mail to 30 N Gould St, Ste R, Sheridan, WY 82801. The notice shall include all of the following:

(a) Claimant's full legal name and current postal address;
(b) all email addresses Claimant has used in connection with the Service;
(c) the specific date or dates on which Claimant accessed the Service that form the basis of the Dispute;
(d) the specific URL or URLs accessed;
(e) the approximate timestamps of the access;
(f) the device type, operating system, and browser used;
(g) the IP address or addresses used to access the Service, if known to Claimant;
(h) a factual basis for Claimant's standing to bring the Dispute;
(i) a specific description of the conduct alleged and the harm alleged;
(j) the legal theory or theories on which the Dispute is based;
(k) the nature of Claimant's fee arrangement with counsel, if any, including whether the representation is on a contingency, fee-sharing, referral, or hourly basis, the rate or percentage applicable, and the identity of any third party providing funding or financing in connection with the Dispute; and
(l) a list of all claims, demands, formal complaints, or arbitration proceedings filed by Claimant within the 24 months preceding the notice that assert substantively similar legal theories or arise from substantively similar conduct, including the names of respondents and the disposition of each.

A notice that omits any of the foregoing is procedurally deficient, and the timelines under this Section do not commence until a compliant notice is received. The disclosures required by subparts (k) and (l) are intended to enable good-faith assessment of the Dispute and to enable any arbitrator to screen for fraud, abuse, or improper purpose.

### 14.3 Informal resolution period

Within 60 days of Respondent's receipt of a compliant notice under Section 14.2, the parties shall engage in informal resolution discussions, including not fewer than two principal-level meetings, each attended by a principal of Claimant and a principal of Respondent. The parties shall coordinate scheduling in good faith, with Respondent making available a reasonable slate of dates within the 60-day period and Claimant selecting from that slate. Meetings may be conducted by video conference. Claimant may be accompanied by counsel or an authorized representative. Failure of Claimant to participate in good faith in the required meetings is a material procedural defect, and no arbitration may be commenced unless and until the requirement is satisfied or expressly waived in writing by Respondent.

### 14.4 Binding arbitration

Any Dispute not resolved through Sections 14.2 and 14.3 shall be resolved exclusively by binding arbitration administered by the American Arbitration Association ("AAA") under its then-current Consumer Arbitration Rules. Filings with any other arbitration provider shall be deemed procedurally deficient and shall not commence the arbitration. The arbitration shall be conducted by a single arbitrator. Venue for any in-person component shall be selected by Respondent, provided the venue is reasonably convenient to Claimant; video proceedings are permitted at either party's election.

### 14.5 Pre-merits threshold review for good faith

As a threshold matter and prior to merits adjudication, the arbitrator is authorized to consider, on the arbitrator's own motion or on motion of a party, whether the Dispute was brought in good faith or bears indicia of fraud, abuse, or improper purpose. The arbitrator may consider, without limitation, the disclosures provided under Section 14.2, the specificity and accuracy of the notice, the conduct of the parties during the informal resolution process, the existence of substantively similar claims previously filed by Claimant or Claimant's counsel, and any other information relevant to good faith. If the arbitrator finds, by a preponderance of the evidence, that the Dispute was brought in bad faith or for an improper purpose, the arbitrator may dismiss the Dispute and may award reasonable fees and costs to Respondent, in each case to the maximum extent permitted by applicable law and the rules of the arbitration provider. This Section is intended to enable fraud screening and shall not be construed to limit Claimant's ability to assert a good-faith Dispute on the merits.

### 14.6 Costs and fees

Each party shall bear its own attorneys' fees and costs except as otherwise provided in this Agreement or required by applicable law. To the maximum extent permitted by applicable law and the rules of the arbitration provider, Claimant shall be responsible for the costs and fees associated with the arbitration; in any event, the allocation of arbitration fees shall comply with the consumer-protection floors imposed by the arbitration provider's consumer rules.

### 14.7 Class-action waiver

Each party may bring claims against the other only in such party's individual capacity, and not as a plaintiff or class member in any purported class, collective, consolidated, or representative action. The arbitrator may not consolidate more than one party's claims and may not preside over any form of representative or class proceeding. If any portion of this class-action waiver is found unenforceable as to a particular Dispute, that Dispute shall proceed in a court of competent jurisdiction (subject to all other terms of this Agreement, including Section 14.10), and the arbitration agreement in Sections 14.4 through 14.6 and 14.8 through 14.9 shall be null and void as to that Dispute. The class-action waiver in this Section 14.7 is non-severable from the arbitration agreement; severance of the class-action waiver from the arbitration agreement is not permitted.

### 14.8 Carve-outs from arbitration

Notwithstanding the foregoing, either party may bring an action in a court of competent jurisdiction in Sheridan, Wyoming for: (a) injunctive or other equitable relief to prevent or stop infringement, misappropriation, or unauthorized use of intellectual property; (b) collection of undisputed amounts due; or (c) any other claim that, as a matter of law, may not be subject to pre-dispute arbitration. Either party may also bring an individual claim in small-claims court if it qualifies. The pendency of any such action shall not affect the parties' obligations under Sections 14.2 through 14.7 with respect to any other Dispute.

### 14.9 Survival

The obligations of Sections 14.2 through 14.8 survive termination of this Agreement.

### 14.10 Governing law and venue

This Agreement and any Dispute shall be governed by the substantive laws of the State of Wyoming, without regard to its conflict-of-laws principles. Any Dispute not subject to arbitration, or that escapes the arbitration agreement for any reason, shall be brought exclusively in the state or federal courts located in or nearest to Sheridan, Wyoming. Each party consents to the personal jurisdiction and venue of such courts and waives any objection based on inconvenient forum or lack of personal jurisdiction.

### 14.11 Severability (this Section)

If any provision of this Section 14 is held unenforceable, the unenforceable provision shall be severed and the remaining provisions shall remain in full force and effect, provided that the class-action waiver in Section 14.7 is non-severable from the arbitration agreement as set forth in that Section. Where any provision is held unenforceable in part, the provision shall be enforced to the maximum extent permitted by applicable law.

### 14.12 California users

If you are a California resident, certain provisions of this Section — including the pre-merits review (14.5), the cost-allocation language in 14.6, and the bad-faith reimbursement in 14.5 — may be limited or unenforceable under California law (including *McGill v. Citibank*, PAGA, and California Code of Civil Procedure §§ 1281.97–1281.99). Nothing in this Section waives any non-waivable right you have under California law, including the right to seek public injunctive relief. To the extent any provision conflicts with a non-waivable California right, that right controls for California users.

## 15. General

(a) **Entire agreement.** These Terms, the Privacy Policy, and any order or plan terms are the entire agreement between you and Company regarding the Service and supersede prior agreements on that subject.
(b) **Changes.** We may update these Terms; material changes will be communicated by reasonable means (e.g., posting an updated effective date or notice in-product). Continued use after changes take effect constitutes acceptance. **For users in jurisdictions that require affirmative opt-in consent to contract changes, changes will not apply until you accept them.**
(c) **Assignment.** You may not assign these Terms without our consent; we may assign in connection with a merger, acquisition, or sale of assets.
(d) **No waiver.** Our failure to enforce any provision is not a waiver.
(e) **Severability.** If any provision is held unenforceable, the rest remains in effect (subject to Section 14.11).
(f) **Force majeure.** Neither party is liable for delays or failures due to causes beyond its reasonable control.
(g) **Notices.** Legal notices to Company must be sent to legal@tasca.dev and/or 30 N Gould St, Ste R, Sheridan, WY 82801.
(h) **Contact.** Questions about these Terms: legal@tasca.dev.
