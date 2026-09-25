# City App (BillEasy GST) — Status Report

Audited: 2026-09-15
App: Indian GST billing & inventory app — Express + EJS + Prisma/PostgreSQL + TypeScript.

## TL;DR

The app is in solid working shape. It builds clean, all tests pass, the database is live and seeded, and a full manual walkthrough (login → create invoice → GST calc → PDF → stock deduction) worked end to end with zero console/server errors. There's no signup flow, no automated route/integration tests, and one real UI bug in the invoice-item autocomplete dropdown (see below).

## What was checked

- `npx tsc --noEmit` — TypeScript compiles with zero errors
- `npx vitest run` — 12/12 tests pass (`src/services/gst/gstEngine.test.ts`)
- PostgreSQL connectivity, migrations (`_prisma_migrations`), and seed data (16 tables present)
- Dev server boot (`tsx watch src/server.ts`) — starts cleanly, no runtime errors in logs
- Every main page via curl + browser: login, dashboard, products, customers, invoices, settings (HSN/Tax master), business profile — all 200
- Full browser walkthrough as the seeded user (`admin@billeasy.in`): login → select customer → search/add product → live GST recalculation → submit invoice → PDF download → stock deduction
- API endpoints: `/api/hsn/search`, `/api/products/search`, `/api/invoices/calculate`
- Auth edge cases: wrong password (401), unauth redirect, 404 handling
- Read-through of `stockService.ts` (negative-stock policy), `gstEngine.ts`, route wiring in `app.ts`

## Working correctly

| Area | Status | Notes |
|---|---|---|
| Build / typecheck | ✅ | Clean, no errors |
| Tests | ✅ | 12/12 GST engine tests pass |
| Database | ✅ | Postgres running, migrated, seeded (2 users, 1 business, 26 products, 4 customers) |
| Auth (login/logout) | ✅ | Session cookie via `connect-pg-simple`, bcrypt password check, correct 401 on bad creds |
| Dashboard | ✅ | Live stats (today's sales, month total, outstanding, low-stock count), recent sales list |
| Product catalog | ✅ | List, search, category/GST/stock filters, stock correctly reflects sales |
| Customers | ✅ | List, create; GSTIN/state captured for place-of-supply logic |
| Invoice creation | ✅ | Product autocomplete, auto-fills price/HSN/unit/GST/discount from product master, live tax recalculation via `/api/invoices/calculate`, correct CGST+SGST vs IGST switching based on customer state vs business state |
| GST math | ✅ | Verified manually: ₹320 × 3, 5% product discount → ₹912 taxable, 18% IGST → ₹164.16, round-off applied to grand total (₹1,076.00) |
| Invoice PDF | ✅ | Puppeteer-generated PDF, correct HSN/tax summary table, ~3.5s generation time |
| Stock deduction | ✅ | Confirmed via DB: stock dropped 110 → 107 after selling 3 units, `StockTransaction` audit row written |
| HSN Master / Tax Master | ✅ | Seeded GST slabs (0/5/12/18/28%) and HSN codes render and are searchable |
| Business profile | ✅ | Setup form works for a fresh (no-business) account |
| Error handling | ✅ | 404 page, centralized `errorHandler`, JSON vs HTML error responses based on `Accept`/`/api/` path |

## Issues found

### 1. Invoice item autocomplete dropdown gets clipped (UI bug, real)
**File:** `public/css/app.css:161,181-185`

The item-name search dropdown (`.autocomplete-menu`) is `position: absolute` inside the line-items table wrapper, which has `.table-scroll { overflow-x: auto }`. Per the CSS spec, setting `overflow-x` to a non-`visible` value forces `overflow-y` to compute to `auto` as well, so the wrapper clips the dropdown instead of letting it float over the page. In testing, the suggestion list was only visible as a ~20px sliver below the input, cut off by the table's own scroll area — functional (click still registers) but hard to see/use, especially with fewer rows on screen. This will get worse on invoices with several line items, where the dropdown for a mid-table row could render almost entirely hidden.

**Fix direction:** don't rely on CSS overflow-clipping to contain it — either move the dropdown to `position: fixed` and reposition it in JS on scroll/resize (or use a small popover/portal pattern), or give `.table-scroll` `overflow: visible` and handle the horizontal scroll a different way (e.g. only the inner content scrolls, not via clipping overflow).

### 2. No self-registration / signup flow
**File:** `src/routes/auth.routes.ts`

Only `login`/`logout` exist — no `register` route or controller. New businesses must be seeded directly into the database (as was done for `admin@cityapp.com`, a user found in the DB with no associated `Business`, which is why it lands on `/business/setup` with nothing pre-filled). This may be intentional (invite-only / admin-provisioned), but worth confirming it's the intended onboarding model before shipping to real users.

### 3. Mistyped URLs redirect to `/login` instead of showing 404 (when logged out)
**Files:** `src/routes/products.routes.ts:9`, `customers.routes.ts:8`, `invoices.routes.ts:7`, `settings.routes.ts:8`

`productsRouter.use(requireBusiness)`, and the equivalent in customers/invoices/settings routers, are registered as router-level middleware with no path, and each router is mounted at the app level with no prefix (`app.use(productsRouter)`). That means these `requireBusiness` checks run for *every* request that reaches them — including totally unmatched paths like `/asdf123` — so an anonymous visitor hitting a typo'd or garbage URL gets redirected to `/login` rather than seeing the actual 404 page. Logged-in users do get a proper 404. Low severity (no data exposure), but it's a correctness/polish gap in routing order.

### 4. No automated route/integration test coverage
Only the GST calculation engine (`gstEngine.test.ts`) is unit-tested. Controllers, stock deduction, invoice numbering, and the auth/session flow have no automated tests — the only verification is manual/browser-based (as done in this audit). Worth adding integration tests especially around invoice creation (money-handling code) and stock concurrency.

## Data currently in the dev database

- 2 users: `admin@billeasy.in` (fully seeded — business "Mehta Stationery Mart", 26 products, 4 customers) and `admin@cityapp.com` (created 2026-09-15, no business yet — likely leftover test data, not a real account)
- 2 sale invoices after this audit (`INV-0001` pre-existing, `INV-0002` created during this walkthrough — real DB row, not a dry run)

## Not covered in this pass

- Product edit/delete forms, customer edit form (only list/create were exercised)
- Payment recording (`POST /invoices/:id/payment`) and invoice cancellation (`POST /invoices/:id/cancel`)
- Business logo upload (multer)
- Concurrent invoice creation / invoice-number race conditions (`numbering.ts`)
- Mobile/responsive layout
