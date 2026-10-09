# Changelog

## Unreleased — API v9 customer hardening

### Breaking security and review cutover

- Migration `0006_customer_hardening.sql` preserves existing content and owners, but suspends legacy non-owner email-based grants. Team members must enable MFA and accept a fresh invitation bound to their exact account ID.
- Legacy sessions have no verified-factor assurance. All team content, including viewer reads and owner exports, requires a code-proved session. Personal/account setup and workspace metadata remain the bootstrap path.
- Sessions now use `__Host-veriq_session` with Secure, HttpOnly, Path=/ and no Domain, preventing sibling-preview cookie tossing in supporting browsers. The old cookie name is rejected; all existing clients must sign in again. HTTP-localhost support was exercised without weakening Secure.
- Immediate email-based member grants are retired. Invitations are single-use, hashed, account/role/workspace-bound and expire after 48 hours. Membership changes revoke outstanding invitations to or from the affected account.
- Reviews and chat cover every active approved policy in the bounded workspace domain. Caller-selected subsets are rejected. New approvals require the current exact policy set and explicit human applicability/account/evidence attestation; historical decisions remain intact.
- **Pre-v9 rollback is unsafe after migration0006:** older code ignores admission suspension and session MFA. Repair forward or use a compatible hardened release; preserve backups and stage the cutover first.

### Implemented controls

- TOTP enrollment, confirmed enablement, code-enforced login/disable/security changes, replay prevention and persisted session assurance. Seeds use AES-GCM with account/purpose binding under an operator-provisioned Worker secret.
- One-time offline recovery codes, atomic rotation and session revocation. No paid email provider, mailbox-verification claim or insecure support reset.
- A single full-policy model batch replaces repeated per-sentence corpus calls. Exact citation checks remain provenance checks, not an independent semantic guarantee.
- Owner-reauthenticated paginated workspace export, configurable retention, transactional purge/audit and typed-name workspace deletion. Account deletion removes the personal workspace and credentials and replaces the account label; stable actor IDs and other teams' contributions remain. This is pseudonymization, not irreversible anonymization or a compliance-erasure guarantee.
- New workspaces default to 90-day history retention; existing workspaces opt in. Related review attestations are erased with reviews, decision-note audit metadata is redacted on purge, and governance events expire after 365 days. Operator exports/provider backups have separate responsibilities.
- Shared atomic inference/storage/abuse ceilings, visible shared capacity and fail-closed free-plan controls. Failed and timed-out calls remain reserved; no paid fallback or production R2 is enabled.
- Offline evaluation at `apps/api/evaluation/evaluate.mjs`, accepting actual exported review records and supplied labels, with explicit missing/error outcomes and no fabricated accuracy claims.
- Matching v9 public onboarding, security/lifecycle controls and guarded release tooling. Code changes do not deploy the service or apply production migrations.

### Verification and external prerequisites

Core verification passed TypeScript and 160 tests. A separate real workerd/local-D1 smoke applied all six migrations and passed 52 HTTP checks without an AI or R2 binding. The offline evaluator was also exercised against two actual API exports under an explicitly controlled, fictional model boundary. These are application-contract checks, not live-model accuracy, an enterprise certification or a production restore drill.

Before customer-team onboarding, the operator must provision and protect `MFA_ENCRYPTION_KEY`, verify the Workers Free plan and shared capacity, stage the admission/MFA migration, complete browser/release checks, and establish data-processing, incident and backup/restore responsibilities. Users must save their recovery code, and inviters must independently verify the delivery channel. SSO/SCIM, verified email, account-action integrations and measured customer accuracy remain outside this release; team-owned material and provider backup copies are not silently claimed erased by account deletion.
