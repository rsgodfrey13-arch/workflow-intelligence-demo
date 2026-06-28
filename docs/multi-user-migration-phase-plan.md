# Multi-user migration: inventory + staged rollout plan

## Inventory (current account boundary = `users.id`)

### Auth/session boundary
- `requireAuth` only checks `req.session.userId`; no workspace context is loaded.
- `GET /api/me` returns user-scoped counts (`user_carriers.user_id`) and no company role/context.

### Company-scoped business data currently user-scoped
- **Saved carriers + carrier alert recipients**
  - `/api/my-carriers*` reads/writes `user_carriers` by `user_id`.
  - Email recipients for carrier alerts use `user_carrier_alert_recipients.user_id`.
- **Contracts**
  - `/api/user-contracts*` reads templates by `user_id`.
  - `/api/contracts*` reads/writes contracts by `contracts.user_id`.
- **Billing**
  - `/api/billing/*` reads/writes `stripe_*` and subscription status from `users`.

### User-owned/personal settings (remain user-owned)
- Auth credentials and password reset state.
- Personal preferences currently in `users` (`time_zone`, per-user toggles, etc.).

### Data leakage risks identified
- Any future multi-user company with these current queries would leak by omission (using `user_id` instead of company boundary).
- “Get by id” style routes for contracts/template ids were protected by `user_id`; those need equivalent `company_id` guards.

## Ownership model (target)

### Company-owned
- account boundary (`companies.id`)
- membership (`company_members`)
- business carriers and shared carrier alerts
- contract templates and contracts
- billing/subscription fields and Stripe customer/subscription ids

### User-owned
- login identity + password + verified state
- personal profile/preferences and default company chooser (`users.default_company_id`)

## Staged migration plan

### Phase 0 (safe foundation)
- Add `companies`, `company_members`, `company_invites`.
- Add `users.default_company_id`.
- Backfill one company per existing user and owner membership.
- Add `company_id` columns + backfill for company business tables.

### Phase 1 (MVP multi-user)
- Add middleware to resolve active company context (`company_id`, `role`, `owner_user_id`).
- Enforce company scoping in internal routes for:
  - saved carriers + carrier alert recipients,
  - contracts/templates,
  - billing reads/writes.
- Enforce owner-only billing access.
- Extend `/api/me` with company context and company-scoped carrier count.

### Phase 2
- Move Stripe webhook plan/subscription writes from `users` to `companies`.
- Update external API routes (`/api/v1/*`) to company boundary.
- Add invite/accept flows and company switching UX.

### Phase 3
- Remove legacy user-scoped assumptions and old uniqueness constraints after data is stable.
- Add full integration tests for cross-company isolation and role permissions.

## MVP multi-user milestone
- Multiple users in one company can share saved carriers/contracts.
- Every internal business query is scoped by `company_id`.
- Non-owners are blocked from billing endpoints.
