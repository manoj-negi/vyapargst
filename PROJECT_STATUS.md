# Project Status — Vyapar-style workflows upgrade

Updated: 2026-11-03. Earlier audit notes remain in `APP_STATUS.md`. The UI/UX redesign is in section 9.

Stack (unchanged): Express + EJS + TypeScript, Prisma 5 + PostgreSQL, Puppeteer for PDFs, decimal.js for money.

## 1. What the inspection found (before changes)

Data lives in one PostgreSQL database (`DATABASE_URL` in `.env`). Uploaded files are stored in `public/uploads/`, which git ignores, so git does not back them up.

| Data | Table(s) |
|---|---|
| Business profile, bank details, logo path | `Business` |
| Invoice numbering, round-off, negative-stock policy | `BusinessSettings`, `InvoiceSequence` |
| Customers (now also suppliers) | `Customer` |
| Items, stock level | `Product`, `Category`, `Unit`, `TaxMaster`, `HSNMaster` |
| Sale invoices (now all trade documents) | `SaleInvoice`, `SaleInvoiceItem` |
| Payments (old, unused, 0 rows) | `Payment` |
| Stock history | `StockTransaction` |
| Login sessions | `session` (not in the Prisma schema; never touch) |

Existing data at upgrade time: 2 businesses, 10 customers, 77 items, 34 invoices (₹99,015.00, all unpaid), 64 invoice lines, 272 stock movements. All checks passed: stock = opening stock + movements for every item, every invoice total = taxable + tax + round-off, and invoice numbers were consecutive (INV-0001 … INV-0034).

These problems were found and fixed:
- Cancelling an invoice twice restored its stock twice. A second cancel is now rejected, including under concurrent requests.
- Editing an invoice recalculated tax from the item's *current* GST rate and price type, which could change historical tax. Lines now keep their issued values.
- No protection against double-clicks or repeated submits creating duplicate bills.
- Payments could exceed the invoice total and could be recorded on cancelled invoices.
- Discounts larger than the line or subtotal produced negative amounts.
- The printed tax summary ignored the invoice-level discount, so it didn't add up to the header totals. No existing invoice had such a discount, so no printed invoice changes.
- More than 21 line rows broke form parsing (Express turns them into an object).
- Invoices didn't record the business or customer details they were issued with.
- Fixed earlier the same day: the logo file was missing from disk, and PDF download failed after Chromium died (the browser now relaunches automatically).

## 2. Backups and verification

| Backup | Location | Notes |
|---|---|---|
| Before any change | `~/vyapargst-backups/2026-11-03_205552/` | `database.dump` + `database.sql` + `uploads.tar.gz` + `SHA256SUMS` + `counts.txt` |
| Right before migrating | `~/vyapargst-backups/2026-11-03_210117_pre-migration/` | dump + uploads + checksums + counts |
| After the upgrade (new format) | `~/vyapargst-backups/2026-11-03_212344_post-upgrade/` | `manifest.json` format used by `npm run restore` |

Verification of the first backup: restored into a separate database `vyapargst_restore_test`. Row counts, money totals and stock total matched. A row-by-row checksum of `SaleInvoice`, `SaleInvoiceItem`, `Product`, `Customer` and `StockTransaction` was identical, and the uploads matched file for file.

The two older backups (no `manifest.json`) can be restored by hand:
`pg_restore --no-owner -d <new empty database> database.dump`, then `tar -xzf uploads.tar.gz -C public`.

## 3. Migration `20261103120000_vyapar_workflows`

The migration is additive only. No table, column or row was dropped or rewritten.

- New optional columns: `Business` (UPI ID and name, signature, invoice terms), `BusinessSettings` (one prefix per document type), `Customer` (party type, opening balance and date, active flag), `SaleInvoice` (document type, conversion and return links, charges, supplier bill number, set-off amount, snapshots, idempotency token, cancel reason), `SaleInvoiceItem.priceType`.
- New tables: `PaymentVoucher`, `PaymentAllocation`, `ExpenseCategory`, `Expense`, `AuditLog`.
- New enum values: stock movement types `SALE_RETURN`, `PURCHASE_RETURN`, `REVERSAL`.
- Invoice-number uniqueness changed from (business, number) to (business, document type, number). This only relaxes the rule: every existing row is a sale invoice.
- Any old `Payment` rows, and any received amount without a payment row, are copied into vouchers. There were 0 at migration time.
- `prisma migrate diff` generated a `DROP TABLE "session"` line, which was removed by hand.

How it was verified:
1. Applied first to the restored test copy. Counts, totals and stock were unchanged, and every original column of every invoice and line was identical.
2. Then applied to the real database after a fresh backup, with the same checks.

Apply only with `npx prisma migrate deploy`. Never use `migrate dev` or `migrate reset` on the real database: they can reset it.

## 4. Implemented (working and tested)

**Business settings**
- Name, address, GSTIN, contact details, logo, signature image, bank details, UPI ID and name, invoice terms.
- Settings → Numbering & Billing: a prefix for each document type, a first invoice number, and optional restart every financial year (April–March).
- Numbers are checked against the GST 16-character limit.
- Also on that page: the round-off rule and the negative-stock rule.

**Parties**
- Customer, supplier or both, with contact details, billing and shipping addresses, GSTIN, and an opening balance (to receive or to pay) with its date.
- Balances are calculated live from the documents and payments, never stored, so they can't drift.
- Party statement with a date range, opening balance carried forward, running balance, and CSV/PDF export.

**Items**
- Existing: SKU/item code, HSN/SAC, category, units, purchase and sale prices with tax-inclusive/exclusive settings, GST rate, opening stock, low-stock level, search.
- New: manual stock adjustment with a required reason, and a stock history that shows notes.

**Sales**
- Estimates (no stock or balance effect).
- Convert an estimate to an invoice: allowed once only (enforced by a database constraint), and the estimate shows the link.
- Sale invoices with due date, line and invoice discounts, delivery/other charges taxed at their own GST rate, round-off, a payment received at creation, and Record Payment.
- Credit notes (sale returns) against an invoice: return quantity can't exceed the quantity sold minus earlier returns, stock comes back, and the amount can be set off against the invoice balance.
- Print and PDF for every document type.

**Purchases**
- Purchase bills with the supplier's bill number and date; stock goes up and a payable is recorded.
- Debit notes (purchase returns) against a bill, with the same safeguards as credit notes.

**Payments and expenses**
- Payment In and Payment Out with cash, UPI, bank, card or other mode, and a reference number.
- Allocated to bills automatically (oldest first) or by chosen amounts; any surplus stays on the party's account as an advance.
- Cancelling a payment reopens the bills it settled.
- Expenses with categories, payment mode and paid-to.

**Editing and cancelling**
- An edit first reverses the document's recorded stock movements, then applies the new ones.
- It is refused if the new total would be less than what has already been paid or set off.
- Cancelling keeps the document and its number and reverses its effects. It is refused while payments or returns are still active against it.
- Every create, edit, cancel, opening-balance change, stock adjustment and settings change writes an `AuditLog` row.

**Not double counting**
- Sales and purchase reports count documents. The Cash & Bank book counts payments and expenses.
- A payment taken while creating an invoice is stored once, as a payment allocated to that invoice.

**GST**
- CGST+SGST within the state and IGST across states, decided from the business state and the party state. On purchases, the supplier's state is used.
- HSN-wise tax summary on documents, place of supply, a "Reverse Charge: No" line, original invoice number and date on credit/debit notes, an "Authorised Signatory" box, and a "Bill of Supply" title when the business isn't GST-registered.
- Decimal arithmetic with round-half-up to paise throughout.
- Historical documents never change when item prices or tax rates change: lines are snapshots, and new documents also store snapshots of the business and party details.

**Reports** (all with date filters where relevant, CSV and PDF export)
- Sales register, purchase register, expenses, stock summary, stock movement, receivables, payables, GST summary (rate-wise outward and inward, plus HSN-wise outward), and Cash & Bank book.
- Party statements are on each party's page.

**Backup and restore**
- Settings → Backup ("Create Backup Now"), or `npm run backup`.
- `npm run restore -- <folder> --confirm`. See section 6.

**Duplicate protection**
- Each form carries a one-time token stored as a unique column, so a repeated submit returns the existing document.
- The Save button is disabled after the first click.

## 5. Test results (2026-11-03)

- `npx tsc --noEmit`: clean. `npm run build`: OK.
- `npm test`: 18/18 GST engine unit tests. New ones cover charges, discount limits, inclusive pricing, and total = taxable + tax + round-off.
- `TEST_DATABASE_URL=… npm run test:integration`: 16/16 against the separate `vyapargst_test` database. They cover:
  - invoice totals, stock, payment and balance saved together
  - IGST for inter-state sales
  - a double submit creating one document
  - 6 concurrent invoices getting consecutive numbers with exact stock
  - editing reversing stock correctly
  - an edit below the paid amount being refused with nothing changed
  - historical rate and price type kept after the item changes
  - business snapshot kept after a rename
  - the negative-stock rule rolling back everything, including the number
  - cancelling being blocked by payments, reversing stock once, and refusing a repeat
  - an estimate converting exactly once
  - credit note quantity limits and set-off
  - a purchase → payment out → debit note chain
  - over-allocation being rejected
  - statement, balances, cash book and GST summary agreeing with each other
  - editing an invoice saved by the previous app version
- The integration setup refuses to run unless the database name ends in `_test`.
- End-to-end check through the real web forms, on a server running against the restored copy of the real data:
  - every page and report returns 200
  - existing invoice preview, edit and PDF work
  - the sales register total equals the original ₹99,015.00
  - the double-submit, payment, cancel-guard, purchase, debit note, payment-out, estimate conversion, expense, stock adjustment, prefix validation and in-app backup flows all behave correctly
- Restore test, on test copies only:
  - a change made after the backup was rolled back
  - the previous database and uploads were kept under new names
  - login sessions survived
  - a corrupted backup was refused before anything changed
- Data persistence: everything is stored in PostgreSQL. The running app's data survived code reloads, and the test server's data survived a stop and restore. A full computer restart wasn't tested, but PostgreSQL keeps its data on disk.

## 6. Backup and restore

**Back up** (app can keep running): Settings → Backup → *Create Backup Now*, or `npm run backup -- <label>`.
- Writes `~/vyapargst-backups/<date>_<time>_<label>/` containing `database.dump`, `uploads.tar.gz` (logos, signatures, item images) and `manifest.json` (checksums, record counts, totals, migrations).
- Each backup is verified as soon as it is written.
- Copy these folders to another drive or a cloud folder regularly: a backup on the same disk won't survive a disk failure.

**Restore** (stop the app first):
```
npm run restore -- ~/vyapargst-backups/<folder> --confirm
```
It checks the backup's checksums, saves the current data as a new `pre-restore` backup, restores into a new database, and compares counts and totals with the manifest. Only then does it rename the current database to `<name>_before_restore_<time>`, give the restored one its name, move `public/uploads` aside to `uploads.before-restore-<time>`, and run `prisma migrate deploy`. Nothing is dropped. To undo, rename the databases and folder back.

**Move to another computer:**
1. Install Node.js 22 (developed on v22.23.4, npm 10.9.9) and PostgreSQL 18 (developed on 18.6). The PostgreSQL server must be the same version as the backup's or newer.
2. Copy the project folder (or `git clone`) and a backup folder.
3. `npm install`, then `npx prisma generate`.
4. Create `.env` from `.env.example` with your own `DATABASE_URL` and a long random `SESSION_SECRET`. Never commit `.env`.
5. Create an empty database (`createdb <name>`), then run `npx prisma migrate deploy`.
6. `npm run restore -- <backup-folder> --confirm`. It needs the database to exist and the app to be stopped.
7. `npm run dev` (or `npm run build && npm start`).

If `pg_dump`/`pg_restore` can't be found, or are older than the server, set `PG_BIN_DIR` in `.env`.

## 7. Not implemented or limited (stated plainly)

- **No GST filing, GSTR-1/3B JSON export, e-invoice (IRN/QR) or e-way bill.** The GST summary is for checking figures only.
- **No Profit & Loss report.** Cost of goods sold isn't tracked, and the stock value uses the current purchase price, not FIFO or weighted average.
- Reverse charge is always printed as "No"; there is no reverse-charge flow.
- Cess: tax rates have a cess field, but invoice lines don't apply it, so cess is always 0.
- No opening cash or bank balances and no separate bank accounts. The Cash & Bank book shows movements by payment mode for the selected period only.
- Payments can't be edited; cancel and re-enter them (keeps the audit trail clean).
- Expenses carry no input GST. Enter GST bills as purchase bills to include them in the GST summary.
- No UPI QR code on invoices (the UPI ID is printed), no batch/expiry/serial tracking, no multi-user roles, no sign-up.
- HSN length (4 or 6 digits depending on turnover) isn't enforced.
- Changing an item's opening stock after creation adjusts its current stock without a movement row (unchanged behaviour). Use Adjust Stock instead.
- Older invoices (INV-0001 … INV-0034) have no stored business/party details or price type. They print with the live details, as before. Editing one uses the item's current price type for its lines, as before.
- Fixed: unknown URLs now show the 404 page instead of redirecting to login (the issue noted in `APP_STATUS.md`); every router checks login per route.

## 8. Remaining tasks / next steps

1. UI pass, which was deliberately left for later.
2. Schedule automatic daily backups (for example a cron or launchd job running `npm run backup -- daily`) and copy them off this machine.
3. Optional GSTR-1 export, a UPI QR code, opening cash/bank balances, and a cost-based profit report once cost tracking exists.
4. Test databases left from this work, which can be dropped by hand when no longer needed: `vyapargst_restore_test`, `vyapargst_restore_test_before_restore_20261103155303`, `vyapargst_test`. Keep `vyapargst_test` if you want to run the integration tests.

## 9. UI/UX redesign (branch `ui-ux-redesign`, 2026-11-03)

Checkpoint first: the functional upgrade was committed as `fc6d135` on `master` and pushed to `anil` (github.com/anilnegi844/vyapargst). The redesign is on the `ui-ux-redesign` branch, created from that commit.

No schema, migration, calculation or route changes were made. Form field names, data bindings and the printed document / PDF templates (`_invoice-document.ejs`, `pdf.ejs`) are unchanged.

### Design system (`public/css/app.css`, rewritten)
- **Tokens:** slate neutrals, navy sidebar, one blue primary, and green/amber/red/slate status colours.
- **Shape and type:** 36px controls (30px small), 6–10px radii, restrained shadows, the Inter font, tabular numbers.
- **Bootstrap:** overridden through its CSS variables, so existing markup picks up the new look.
- **Shared components:**
  - page header (title, context line, back link, actions)
  - panels, and form sections, some of them collapsible
  - the sized 12-column form grid `.fgrid` (`s2`–`s9`)
  - price + With/Without Tax pairs, segmented controls, a compact image uploader with preview
  - sticky action bar
  - KPI tiles, filter bar and chips, data tables, status badges
  - empty states, alerts, modals, dropdowns, tiles, definition lists
- **Accessibility and printing:** visible keyboard focus everywhere, a skip link, and print rules that hide the app chrome.
- **Older class names** (`btn-primary-app`, `btn-accent`, `stat-card`, `sale-*`) still work. Orange "accent" buttons are now the blue primary.

### Shared behaviour (`public/js/app.js`, new; opt-in data attributes)
- **Sidebar:** desktop collapse is remembered between visits; on mobile it's a drawer with a dimmed overlay and Esc to close.
- **`data-confirm` dialogs** for consequential actions. They can ask for a reason, which is used for cancelling payments and expenses; this replaces the browser `confirm()`/`prompt()`.
- **Saving:** a spinner and double-submit block on every POST form. The clicked button's value (Save & print, Save & add another) is sent exactly once.
- **`data-dirty-guard`:** warns before leaving a form with unsaved changes.
- **Lists remember their filters:** back links on detail and form pages return to the filtered list.
- **`data-sortable` tables** with keyboard-accessible column sorting, plus client-side pagination of 50 or 100 rows over the data the server already sends.
- **Save & print:** saving with print opens the print dialog on the saved document.
- **Shortcuts:** Alt+I new invoice, Alt+R payment in, Alt+P purchase; Ctrl+S save and Ctrl+P print as before.

### Template helpers (`src/lib/viewHelpers.ts`, available in every view)
- `inr`, `fdate` (03 Nov 2026), `qty`, payment status labels and classes, mode labels.
- `fieldError` / `invalid` show validation errors beside the field. Controllers pass `fieldErrors` from Zod paths.

### Screens
Every route was audited and moved onto the shared header, panel, table and form patterns:
- dashboard
- items list and form
- parties list, form and statement
- all five document types (list, form, detail)
- payments (list, form, detail) and expenses (list, form)
- reports index and report page
- business profile, numbering & billing, tax rates, HSN codes, backup
- login, 404 and error pages

Highlights:
- **Add Item:**
  - five sections: basic details, units, pricing & tax, stock, and optional image/discount
  - fields sized to their content, with prices aligned with their tax-treatment selector
  - SAC label and stock section hidden for services
  - image upload with preview, replace and remove
  - sticky Save / Save & add another
  - stock adjustment and stock history in a side column when editing
- **Invoice / purchase entry:**
  - keyboard-driven item search (↑/↓/Enter/Esc); Enter moves through a row and adds a new row at the end; Alt+A adds a row
  - "Create item …" in the search results and a "New item" button open a dialog that saves the item and fills it into the row without losing the invoice
  - stock shown under each line
  - per-line CGST/SGST/IGST columns hidden below 1500px so the item column has room; the tax split stays in the totals panel and on the print
  - sticky bar with total, balance, Cancel, Save & print and Save
- **Lists:** KPI row, compact filter bar with Clear, sortable columns, money right-aligned, consistent dates and badges, icon row actions, truncation with tooltips for long names, empty states that tell you what to do next, and sticky headers inside a contained scroll area.
- **Document detail:** status badge, primary action first, less common actions (return, cancel) in a "More" menu, a linked-records table (payments, returns, conversions), and the cancel dialog with a required reason.
- **Reports:** a tile index with descriptions; report pages with date presets (This month / Last month / This FY), an Export menu (PDF/CSV), Indian-format amounts on screen (CSV keeps plain numbers), and no sorting on the GST summary so its sections stay in order.

Small fixes made along the way:
- Duplicate live-filter script on the item list (every keystroke fetched twice).
- Item category lost after a validation error.
- Tax/HSN "add" and duplicate GST rates crashing with a 500 page; they now show a message.
- Typed email lost on a failed sign-in.
- Business profile now confirms the save and stays on the page.
- Invoice document scrolls inside its card on phones instead of making the page overflow.
- Quick-create dialogs close reliably even when saved while still opening.

New endpoint: `POST /api/products`, the JSON quick-create used by the invoice "New item" dialog. It uses the same validation as the item form.

### Checks performed
- `tsc --noEmit` clean, `npm run build` OK, `node --check` on all browser scripts. Unit tests 18/18 and integration tests 16/16, unchanged.
- **All 50 pages and reports return 200** on a server running against the restored copy of the real data. Unknown URLs return 404.
- **Screenshots reviewed at 1366×768, 1440×900, 1920×1080 and 390×844 (mobile)** for dashboard, lists, invoice/purchase entry, Add/Edit Item, party statement, payment form, reports, settings and the business profile. Horizontal page overflow was measured automatically; the only case, the invoice preview on mobile, is fixed.
- **Scripted browser checks on test data** (all pass):
  - keyboard item search and selection; Enter adds a row
  - create item from the invoice without losing rows
  - live totals; Save & print saves once and opens print
  - Add Item validation marks the field and keeps the typed values
  - unsaved-changes warning
  - delete confirmation (dismissed, nothing removed)
  - back link keeps list filters
  - column sorting; sidebar collapse remembered
- **Invoices created through the new UI** have header total = taxable + tax + round-off, every line saved, and stock movements written.
- **Printing:** the invoice in print mode shows only the document. Server PDFs for invoice, purchase bill and a report download (application/pdf).
- **Real data:** only the test copy was written to; the real database was not.

### Remaining UI issues / ideas
- The item table is horizontally scrollable on phones; entry works but is cramped. A dedicated mobile line editor would be better.
- Changing the party on Payment In/Out reloads the form; choose the party first, then type the amount.
- Client-side sorting and pagination cover the up to 500 rows a list loads. Older documents are reached by narrowing the date filter (the list says so).
- Inter is loaded from Google Fonts. Offline, the system font is used and looks slightly different.

## 10. Section / Department on sale documents (branch `invoice-department`, 2026-11-03)

Built on `ui-ux-redesign`.
- **Backup before the change:** `~/vyapargst-backups/2026-11-03_224032_pre-department`.
- **Migration `20261103180000_invoice_department`** is additive: a nullable `SaleInvoice.department` column plus an index on (business, customer, department). It was applied to the test copy first, then to the real database. Invoice count, totals, balances, customers and stock were unchanged; existing invoices have no department (NULL).
- **How it's stored:** the department is saved on each sale invoice, estimate and credit note, trimmed, with an empty value stored as nothing (max 80 characters). Purchase documents ignore it. The customer record is never written to, so one customer can be billed for many departments. Changing it on an invoice is recorded in the audit log.
- **Invoice form:** an optional "Section / Department" field beside the customer. Suggestions are departments used on that customer's earlier documents (most used first), plus the section/department saved on the customer record. A new value can be typed.
- **Carried forward:** converting an estimate and raising a credit note copy the department. A new **Duplicate** action (detail page → More) copies the party, department, lines, discount, charges and notes; it gets a new number and date, no payments are copied, and everything stays editable.
- **List:** a "Section / Department" column beside the customer ("—" when empty; clicking a value filters by it). The search box covers number, customer and department. A Department filter includes a "No department" option.
- **Detail, print and PDF:** the department shows in the detail summary line, and the printed invoice and PDF show "SECTION / DEPARTMENT: …". Invoices without their own department still print the customer record's SECTION/DEPARTMENT, as before, so existing printouts are unchanged.
- **Exports:** the Sales Register (screen, CSV, PDF) has a Section / Department column. The Purchase Register is unchanged.
- **API:** `GET /api/customers/:id/departments` provides the suggestions.

Verified:
- Type check and build pass. Unit tests 18/18; integration tests 18/18, including two new ones: per-invoice storage, edits isolated to one invoice, customer untouched, totals unchanged, audit entry, register column, purchases ignored.
- Browser checks on the test copy: create with a suggested department, detail line, printed line, duplicate pre-fill then change, edit, suggestions learning new values, list column with "—", department filter, "No department" filter, search by department, and no page overflow.
- The PDF's source HTML shows the department for new invoices and the old SECTION line for old ones. The CSV export has the column, and all related pages return 200.
- The real database was not written to except by the migration.

Not done (needs a decision): earlier, separate customer records were created per section (for example two "Canara Bank - Regional Office" records, with Retail Asset Hub and GA). They are left as they are. Merging them into one customer and moving the section onto their invoices would be a data change, so it was not done.

### Backfill of existing invoices (2026-11-03)
At your request, existing invoices now show the section they were issued with.
- **Backup first:** `~/vyapargst-backups/2026-11-03_224852_pre-department-backfill`.
- **What ran:** `npm run backfill:departments -- --apply` copied the customer record's section / department onto each sale document that had none (the party snapshot is used first when one exists). It ran on the test copy first, then on the real database.
- **Result on the real database:** 34 invoices filled (GA 16, Retail Asset Hub 12, HRM 5, Insurance Section 1). Totals, balances, payments, stock and every customer record are byte-identical before and after.
- **Audit and undo:** each change has an `AuditLog` row (action `BACKFILL_DEPARTMENT`). To undo, set `department` back to NULL for those entity ids. Running the script without `--apply` only previews.
- **Printout change:** these invoices now print "SECTION / DEPARTMENT: HRM" instead of "SECTION: HRM". The value is the same; only the label differs.

## 11. In-app dialogs and unsaved-changes protection (branch `custom-dialogs`, 2026-11-03)

Built on `invoice-department`. There are no database or calculation changes.

**Audit.** The only native popup left was a `window.confirm()` fallback in `app.js`; it has been removed. Leaving a changed form used the browser's own `beforeunload` popup even for clicks inside the app. The invoice "Cancel" dialog and the payment dialog submitted the whole page, so a refusal (for example "has payments, cancel those first") only appeared as a toast after the dialog had closed.

**Shared dialog: `public/js/dialogs.js` (`AppDialog`)**
- **Types:** `confirm` (optional required-reason field and an `action` run while the dialog shows progress), `alert` (errors) and `unsaved`.
- **Look:** title, short message, a tone icon in a coloured circle, explicit button labels ("Cancel sale invoice", "Keep sale invoice", "Discard changes"), and red styling for destructive actions.
- **Layout:** centred, at most 440px wide, rounded with a soft shadow and a dimmed backdrop. On phones the buttons stack full width with the safe action at the bottom. Long content scrolls while the buttons stay visible.
- **Behaviour:**
  - clicking the backdrop does nothing; Esc cancels
  - focus moves into the dialog, Tab stays inside, and focus returns to where it was afterwards
  - destructive confirmations start on the safe button, and reason dialogs on the reason field
  - while an action runs, both buttons are disabled and Esc is ignored
  - if the action fails, the dialog stays open with the server's message, and nothing else happens
  - cancelling never runs the action and never clears anything

**Wiring (all to existing actions)**
- `form[data-confirm]` forms: remove item, delete HSN code, disable tax rate, cancel invoice/estimate/return/purchase (with reason), cancel payment (with reason), cancel expense (with reason). Each is sent in the background; success continues to the page the server returns, with its toast.
- `form[data-dialog-form]` dialogs (record payment, add/edit HSN code) are also sent in the background, with errors shown inside the dialog.
- Server side (`src/app.ts`): requests with `X-Dialog: 1` get `{ redirect }` or `422 { error }` instead of a redirect. Controllers are unchanged.
- The stock adjustment no longer asks for confirmation (routine, and already requires a reason). The new customer, new item, payment and HSN dialogs ignore backdrop clicks, so typed data is not lost by accident.
- Messages: success and info appear as toasts; error messages after a redirect (for example "A 18% tax rate already exists") open an error dialog instead of a toast that disappears. Field errors stay inline beside the field.

**Unsaved changes (`app.js`, forms with `data-dirty-guard`)**
- **When it counts as unsaved:** the form's current values (FormData, file names and sizes) differ from what the page loaded with. Typing and then undoing doesn't count. A form re-shown after a failed save counts as unsaved, because those values aren't stored yet. Submitting clears the state.
- **In-app navigation:** links (sidebar, Cancel, back links), other forms such as Logout, the Alt+I/R/P shortcuts, and changing the party on Payment In/Out (when anything else was typed) show the "Unsaved changes" dialog. "Keep editing" stays with every value intact; "Discard changes" continues to the original destination. The native warning never appears on top.
- **Back/Forward:** when a form first becomes unsaved, one history entry is added for the same page. Back then shows the dialog; Keep editing stays, Discard goes to the real previous page. Saving removes that entry first, so Back after a save goes where you expect. A page restored from the browser's cache after a discard or a save reloads fresh instead of showing old values as unsaved. Side effect: once a form has unsaved changes, any Forward history from that page is cleared (normal browser behaviour when a page adds a history entry).
- **Browser's own warning:** refresh, closing the tab, typing another address and leaving the site still show the browser's `beforeunload` warning, which browsers don't allow to be restyled.

**Checks**
- Type check and build pass; unit tests 18/18 and integration tests 18/18.
- No `alert(`, `confirm(` or `prompt(` remain in `public/js` or `views`. All main pages return 200.
- Browser suite, 34 checks on the test copy, all passing:
  - a clean form leaves without asking
  - the custom dialog's title, message and buttons, with no native warning alongside
  - default focus, focus trap and focus return, backdrop clicks ignored, Esc
  - Keep editing keeps values; Discard goes to the destination; undone typing doesn't count
  - Back shows the dialog (both choices); Forward shows a fresh form
  - successful save: no prompt, a toast, and Back is clean; failed save keeps the values and still asks
  - refresh and a typed address get the native warning; Logout and Alt+I ask first
  - cancelling an invoice that has payments: danger styling, reason required, server refusal shown inside the open dialog, invoice untouched
  - confirmed cancel with a double click runs once (database: one audit row, one reversal per line)
  - payment dialog keeps its server error and ignores backdrop clicks
  - error flash appears as a dialog; dialog fits a 390px screen
- The earlier invoice-entry flow (keyboard entry, new item mid-invoice, Save & print sending `after=print` once) and the department flow were re-run and pass.
- Bugs found while testing and fixed:
  - Quick-add dialogs (new customer or item) wrongly triggered the unsaved prompt.
  - A discarded or saved form came back with its old values when restored from the browser's cache.
  - A template error on the invoice detail page left over from removing the old cancel dialog.

## 12. Visual redesign: "Indigo" design system (branch `ui-updates`, 2026-11-04)

This was a visual change only. Records, routes, APIs, validations, calculations, payments and stock behaviour are unchanged, and there were no database changes. The print and PDF templates (`_invoice-document.ejs`, `pdf.ejs`, `reports/print.ejs`, `pdf.ts`) are untouched, so screen and print styles stay separate.

### Design system (`public/css/app.css`, rewritten; every existing class kept)
- **Colours:**
  - Cool slate neutrals on a soft blue-grey background.
  - A deep indigo-navy brand (sidebar, hero bands, the invoice total).
  - Indigo primary with a violet lift.
  - Supporting accents: teal (money in, the current month), amber (purchases, warnings), rose (money out, destructive actions), sky and violet.
  - Status colours: green (paid), amber (partly paid), rose (unpaid), slate (cancelled), indigo (open).
- **Type:** Plus Jakarta Sans for headings, amounts and section titles; Inter for UI and table text, with tabular numbers throughout.
- **Depth:**
  - Layered white surfaces with a 1px top highlight and soft directional shadows (`--sh-1/2/3/float`).
  - Raised icon tiles (gradient, inner highlight, coloured drop shadow) on summary cards, report tiles, dialogs and the active navigation item.
  - Gradients are used only on primary and danger buttons, the sidebar, the dashboard hero, the login brand panel and the invoice total.
- **Shape and motion:** radii 6/8/10/14/18px; 38px controls (32px small, 40px+ touch on phones); 160ms transitions; `prefers-reduced-motion` removes movement and animation.
- **Buttons:**
  - Primary: gradient, lift on hover, pressed inset, focus ring that keeps the depth.
  - Secondary: white, raised. Tertiary: text. Tinted: indigo, teal, amber, rose. Danger: rose gradient. Icon-only: square, with a tooltip.
  - Loading state: spinner with label; disabled state is flat.
- **Forms:**
  - Inputs and selects with a custom chevron, a soft inset and an indigo focus ring.
  - Validation shows a rose border and an inline message with an icon.
  - Section titles have an accent bar; segmented tabs, chips, the image uploader and price + tax pairs are restyled.
  - Fields keep their content-based widths (HSN, quantities, GST, dates and prices narrow; names, addresses and notes wide).
- **Tables:** compact uppercase sticky headers, a hover tint with an indigo edge, right-aligned money and quantities, document numbers that never wrap, pill status badges with a dot, polished empty states and pager.
- **Overlays:**
  - Dropdowns: elevated, with a pop-in animation, icon-led items and section headers.
  - Dialogs: blurred navy backdrop, rounded panel, raised tone icon.
  - Toasts: dark with a coloured status mark. Tooltips: dark.

### Shell
- **Sidebar:**
  - A deep gradient with soft indigo and violet glows.
  - A brand block (logo tile, business name, "Billing & Inventory").
  - Grouped menu (Sale, Purchase, Masters, Insights, Settings) with icon tiles.
  - The active item has a gradient icon tile, a tinted background and a glowing edge marker; hover and focus states are clear.
  - A user card with sign-out.
  - When collapsed: icons only, group separators, and Bootstrap tooltips with each page name (shown only while collapsed).
  - On phones it's a drawer with a dimmed overlay.
  - Every previous destination is kept.
- **Header (glass bar):**
  - The date.
  - A financial-year menu with real links: Sales register, Purchase register and GST summary for the current and previous FY with their exact date ranges, plus All reports.
  - The Create menu (with shortcuts).
  - An account menu: name, business, Business profile, Numbering & billing, Backup, Log out.
- **Dropdowns:** they now use fixed positioning, so scrolling tables and panels can't clip them, and they flip or shift near screen edges. The invoice item search opens upwards when there's no room below and stays inside the window.

### Screens
- **Dashboard:**
  - A greeting hero with this month's net sales and New invoice.
  - Six summary cards with coloured raised icons (3 × 2 on laptops, one row from 1600px, 2 columns on phones). The metrics and calculations are unchanged.
  - Coloured quick-action tiles.
  - A "Net sales, last 6 months" bar chart built only from real data: sale invoices minus sale returns per month, cancelled excluded, with the current month in teal and the exact amount and invoice count on hover.
  - Recent sales (now showing the department) and Low stock panels with icon headers.
- **Login:** a split screen with a brand panel and feature list, and the sign-in card.
- **Everything else** (invoices, estimates, purchases, returns, items, customers, suppliers, statements, payments, expenses, reports, settings, backup, error pages, dialogs) picks up the new system through the shared components: list KPI cards with accent edges, report tiles with coloured icons, filter bars, tables, forms and dialogs.
- The Section / Department column and all department values are unchanged.

### Checks
- Type check and build pass; unit tests 18/18 and integration tests 18/18.
- **All 44 pages and reports return 200** on the test copy. Server PDFs still generate.
- **Screenshots reviewed for 24 screens** at 1366×768, 1920×1080, 820×1180 (tablet) and 390×844 (phone), with automatic overflow measurement. Two phone overflows (Tax rates, Backup) were fixed by letting grid columns shrink.
- **Interaction checks:**
  - the FY menu opens on screen and links to the correct dates
  - the account menu fits at the right edge; the Create menu works by keyboard
  - the collapsed sidebar shows the page-name tooltip (none when expanded) and is remembered
  - keyboard focus ring on primary buttons; hover lift; no movement with reduced motion
  - the "More" menu is fully visible and fixed-positioned; item search stays on screen in a short window
  - dialog look checked
- **Earlier suites re-run:** invoice entry 15/15, departments 12/12, dialogs and unsaved changes 34/34. Two test scripts were updated for the new dialog markup and column order.
- **Real database not written to:** 34 invoices, ₹99,015.00, 34 with department, stock total 1,357.

### Notes
- The fonts come from Google Fonts; offline, system fonts are used.
- The chart covers six calendar months, including any months with no sales.

## 13. Previous discounts per party and item; separate Section and Department (branch `ui-updates`, 2026-11-04)

### Previous discounts
- **What it does:** on a new sale invoice, picking an item for a customer fills in the discount that customer last got for the same item. A small line under the discount says where it came from, for example "Previous discount: 3% · INV-0029 · 17 Oct 2026 · Same section". The discount stays fully editable.
- **Where it comes from** (`src/services/documents/discountHistory.ts`, `GET /api/invoices/previous-discounts`):
  - only saved, active sale invoices count (no estimates, credit notes or cancelled invoices), matched by customer id and product id, never by name;
  - with a Section and/or Department entered, an invoice for the same one wins; if there is none, the customer's latest invoice for the item is used and the line says so ("No history for this section; from this party (Section …)");
  - "latest" means latest invoice date, then latest saved, then highest number; within one invoice the first line for the item;
  - when editing an invoice, that invoice is left out.
- **Discount types:** percentages and ₹ amounts keep their type and value. A ₹ discount is the amount off the whole line, which is the only fixed-discount meaning the app has, and it is shown that way ("₹15 off the line"). Percentages are applied to the new quantity and price by the usual calculation.
- **Rules kept:**
  - an earlier 0% counts as a real value;
  - with no history, the item's own default discount stays, as before;
  - a discount you type is never replaced: not by recalculations, quantity changes or a lookup that answers late. The helper offers "Use 3%" instead;
  - changing the party, Section or Department after adding items asks first ("Apply previous discounts?" / "Keep current discounts") and lists what would change. Nothing is asked when nothing would change;
  - saved and copied lines (edit, duplicate, convert, return) are never auto-changed. On an invoice being edited the helper is not shown, because the "previous" invoice could be a later one;
  - history is read only from saved invoices, so saving makes the final discounts available and unsaved forms change nothing. Item master discounts, other customers and past invoices are not touched; tax, rounding, stock and payment calculations are unchanged.

### Section and Department
- **Migration `20261104180000_section_and_department`** (additive):
  - adds `SaleInvoice.section` (nullable) and `SaleInvoice.legacySectionDepartment` (boolean, default false), plus indexes on (business, customer, section) and on `SaleInvoiceItem.productId`;
  - it changes no existing text. Rows that already had a value in `department` are flagged `legacySectionDepartment = true`, because that value was entered under the combined label and could be either.
- **Backups:**
  - `~/vyapargst-backups/2026-11-04_230719_before-section-department-split` (before the migration);
  - `~/vyapargst-backups/2026-11-04_231507_before-classify-sections` (taken automatically by the classification script).
- **Classifying existing values** (`npm run classify:sections`, preview by default; `--apply` backs up first, then saves in one transaction with an audit row each):
  - a value is classified only when the records show where it came from: the party snapshot saved with the document, or the earlier backfill's audit row (source "customer record") with the value unchanged since and the customer record also unchanged since;
  - the text is never changed; it only moves to the matching field.
  - **Real database result:** all 34 invoices were backfilled on 2026-11-03 from the customer record's **Section** field (Department was empty on those records, and they have not changed since), so all 34 are now Section (GA 16, Retail Asset Hub 12, HRM 5, Insurance Section 1) and none are left unclassified.
  - Totals (₹99,015.00), balances, 64 invoice lines and stock (1,357) are unchanged. Audit action: `CLASSIFY_SECTION_DEPARTMENT`; undo steps are in the script header.
- **Invoice form:** two optional fields, Section and Department, each with suggestions from that customer's earlier invoices and its customer record (no customers are created or changed).
  - If an invoice still has an unclassified older value, the form shows it with "It's a section" / "It's a department". Until you choose, it is kept and saved exactly as before; choosing moves the same text into that field, and the original stays in the audit log.
- **Detail, print and PDF:**
  - "Section: …" and/or "Department: …", each only when filled;
  - with neither, the invoice header closes up to two columns with no empty space;
  - an unclassified older value prints as typed, without a label;
  - the combined "SECTION / DEPARTMENT" label is gone, and so is the old fallback to the customer record's values (every existing invoice has its own value).
- **List, filters, exports:**
  - separate Section and Department columns, each shown only when the listed documents use it, so the real data shows only Section;
  - separate Section and Department filters, each with a "No …" option;
  - search covers both;
  - unclassified values are marked "Unclassified";
  - the Sales Register (screen, CSV, PDF) has Section and Department columns, plus an "Unclassified" column only when such values exist;
  - the dashboard and the detail subtitle use the labelled form.
- **Older backfill script** (`backfill:departments`) now fills only documents with neither field, and marks what it fills as unclassified.

### Checks
- Type check and build pass. Unit tests 21/21 (new: display rules). Integration tests 20/20, including new ones for:
  - separate storage, labels and register columns, with the customer untouched;
  - unclassified values kept until classified, with the audit trail;
  - previous discounts: section first, party fallback, tie-break, 0%, fixed ₹, other customers, estimates, returns and cancelled excluded, the edited invoice excluded, nothing written.
- **INV-0029 on the real database** (read-only): A4 Ream Satia 3%, Tissue Box 2ply 20% (and 0% for the two other tissue lines), with or without the section. INV-0029 itself was unchanged (checksum before and after).
- **Browser, previous discounts** (test copy, 30 checks):
  - the INV-0029 prefill and helper text;
  - the 20-quantity recalculation (₹4,603.39);
  - a manual 15% kept through recalculations;
  - a late lookup not overwriting a typed 7%;
  - the section-change prompt, both Keep and Apply;
  - a party change prompt only when something differs;
  - save and reopen keeping the saved values;
  - a new invoice picking up the just-saved 12.5%;
  - an unsaved 44% not changing history;
  - a customer with no history keeping the default.
- **Browser, Section and Department:**
  - Section-only, Department-only, both and neither, each checked on screen, in print media and in the downloaded PDF's text (header columns 3/3/3/2);
  - edit form round trip, list columns and filters, CSV headers;
  - the unclassified flow: marked in the list, printed without a label, kept when saved, then classified as Department and printed "Department: …".
- **Earlier suites re-run:** invoice entry 15/15 (the sort check now finds the Amount column by its header), dialogs and unsaved changes 34/34. Page smoke tests return 200, and there is no horizontal overflow on the form or list at 390, 820, 1366 or 1920px.

### Fix: Section and Department filled from the selected party (2026-11-05)
- **Cause:** choosing a party on the invoice form only loaded *suggestions* for the two fields (the datalists); it never put the party's saved Section / Department into them. This was already true of the single combined field and stayed so after the split. The data was fine: for example, "Canara Bank-circle office" (`a311068a…`) has `section = "HR"`, `department = NULL`, and "(HR)" in the party list comes from that saved field.
- **Fix** (`views/invoices/form.ejs`, `public/js/invoice-form.js`, `POST /api/customers` response):
  - each party option carries its saved `section` / `department`, and selecting a party fills both fields from them (blank when not saved); the fields stay editable;
  - switching party replaces values filled from the previous party and clears fields the new party has no value for;
  - a value you typed is replaced only after "Replace Section and Department?" ("Use party's values" / "Keep my values");
  - nothing is filled when an existing invoice opens, so its saved values stay;
  - an invoice never writes back to the party;
  - values come from the selected option, not a request, so a slow answer can't fill an old party's values; suggestion answers for a party no longer selected are ignored;
  - the previous-discount check now runs once, after the fields are filled for the new party.
- **Checked** on the test copy (with the HR party copied in), 15/15:
  - HR party gives Section HR and Department blank; a party with both fills both; a party with neither clears both;
  - a typed value prompts, and both Keep and Use work;
  - rapid switching ends with the last party's values;
  - save, reopen and print show "Section: HR" plus a Department line only when filled (PDF too);
  - opening an invoice keeps its saved values, and the party record is unchanged.
- **Re-run:** discount checks (the party change now prompts once, with the Section already filled), Section/Department display checks, invoice entry 15/15, build, unit 21/21, integration 20/20.

## 14. Android and iOS apps (Capacitor 8, `mobile-app/`, 2026-11-05)

- **Checkpoint first:** commit `8bcca9d` was pushed to `ui-updates` before any mobile work.
- **Design:**
  - every screen is rendered by the backend (EJS), so there is no standalone frontend to package. The apps open the same backend in a native WebView (`server.url` per environment), keeping one frontend and one set of business logic and data;
  - the packaged `www/` holds only the "Connection required" screen with Retry (`server.errorPath`);
  - the app is identified by the user-agent suffix `TheCityCartApp/<version>`; only then does the layout load `public/js/vendor/capacitor-bridge.js` (built from `mobile-app/bridge` with esbuild, `@capacitor/core` 8.6.0) and `public/js/native.js`.
- **Native behaviour** (`public/js/native.js`):
  - PDF and CSV downloads (invoice PDF, Save & print, the Print button, report and statement exports) are fetched with the session, written to the app cache (Filesystem) and opened in the share sheet (Share); closing the share sheet is not treated as an error;
  - Android Back closes, in order, a dialog, the drawer, a menu or item suggestions; then goes back a page (the unsaved-changes guard asks); on the dashboard it minimises the app;
  - other websites open in the in-app browser;
  - keyboard events hide the bottom bars and keep the field in view;
  - splash hidden on load; dark system-bar icons;
  - a connection check when the app returns to the foreground.
- **Phone layout** (shared CSS and JS, so phone browsers get it too; desktop unchanged):
  - bottom navigation: Dashboard, Sales, Items, Parties, More (the More tab opens the full menu);
  - safe areas (`viewport-fit=cover`), 44px touch targets, 16px inputs (no iOS zoom);
  - Save bars above the bottom navigation; scroll padding so focused fields stay clear of the bars;
  - invoice lines as cards; list tables as cards; filters behind a "Filters (n)" button; keyboard hints hidden on touch screens;
  - a "No connection" banner with Retry (website and app).
  - Backend: `GET /healthz`.
- **Environments** (`mobile-app/config/environments.mjs`):

  | Environment | Server address |
  |---|---|
  | android-emulator | `http://10.0.2.2:3000` |
  | ios-simulator | `http://localhost:3000` |
  | device | the Mac's Wi-Fi IP, auto-detected or `MOBILE_DEV_HOST` |
  | production | `MOBILE_PRODUCTION_URL`, which must be a public https address |

- **Network security:**
  - cleartext is allowed only in Android debug builds (`src/debug` network security config) and the iOS Debug configuration (`Info-Debug.plist`, local networking);
  - release builds are HTTPS-only, and a Gradle check refuses a release build without an https server;
  - WebView debugging is off in production, and Android `allowBackup` is off;
  - no credentials are in the app; sign-in uses the existing session cookie on the same origin, so no CORS changes were needed.
- **Store preparation:**
  - app ID and name come from `MOBILE_APP_ID` / `MOBILE_APP_NAME` (default `com.thecitycart.billing`, "THE CITY CART");
  - icons and splash are generated from the brand logo (`npm run assets`); `npm run version:set`;
  - an Android signing hook reads the git-ignored `keystore.properties`; signing steps for both stores are in `mobile-app/README.md`;
  - permissions: Android `INTERNET`; iOS a camera reason string (the upload fields offer Take Photo), with Local Network in Debug only.
  - Note: Capacitor documents `server.url` as meant for live reload, and Apple guideline 4.2 applies to web-content apps; the README covers this. Nothing was published or purchased.
- **Verified here:**
  - website type check, build and unit tests 21/21; invoice entry 15/15; party autofill 15/15;
  - mobile unit tests 3/3 (addresses, https-only production);
  - `cap add android` / `cap add ios`, `cap sync`, `cap doctor` ("looking great" for both); production sync writes https, no cleartext and no WebView debugging.
  - **Phone checks** in Chromium at 390×844 with the app's user agent and a simulated Capacitor 8 native side, 46/46:
    - login, bottom navigation, More drawer, the Back cases, unsaved-changes prompt on Back;
    - party autofill and previous discount on the phone;
    - Save bar above the navigation, touch targets, keyboard hiding;
    - the real PDF bytes saved and shared for Save & print, the PDF button and Print;
    - CSV export, share cancel, external links in the in-app browser;
    - offline banner and the offline download message;
    - no sideways scrolling on 12 screens; the website not loading native scripts; desktop without the bottom navigation.
- **Not verified on this Mac, because the tools are not installed:**
  - Gradle builds, the debug APK and the Android emulator need Android Studio 2025.2.1+ and an SDK;
  - the iOS build and simulator need Xcode 26+;
  - real-device runs, real share sheets and the file pickers in the native WebViews.
  - The native code paths were exercised only through the simulated bridge. Run the README steps 4–7 once these tools are installed.

## 15. Stamp & signature in the invoice signatory box (2026-11-05)

- **Backup first:** `~/vyapargst-backups/2026-11-05_104004_before-stamp-signature`.
- **Migration `20261105120000_stamp_signature`** (additive) adds these `Business` fields; `signaturePath` stays the image that is printed:

  | Field | Meaning | Default |
  |---|---|---|
  | `signatureOriginalPath` | the upload as received | — |
  | `signatureCleanPath` | the transparent version | — |
  | `signatureUseClean` | print the transparent version | true |
  | `signatureWidthMm` | size on the invoice | 50 |
  | `signatureOnInvoices` | show on invoices | false |
  | `signatureHidesHeading` | the image includes "For <business>" | true |

  A business that already had a signature keeps printing it (none did). Applied to the test copies and the real database.
- **Business Profile → Stamp & signature** (replaces the old Signature uploader):
  - upload (PNG, JPG or WEBP, up to 8 MB, so a phone photo fits; the logo stays at 2 MB), replace, remove (with Undo before saving);
  - background: Transparent (recommended) or Original upload;
  - size slider from 25 to 80 mm, with a to-scale preview of the signatory box;
  - "Show stamp and signature on invoices";
  - "The image already includes 'For <business>'", which leaves out the printed heading so it is not duplicated.
- **Transparent version** (`src/services/business/stamp.ts`, `sharp` 0.35.5):
  - the paper colour is estimated locally with a max filter (shadows and gradients handled); alpha comes from the distance to the paper; soft edges are un-blended so no halo remains;
  - empty margins are trimmed; the ink pixels and the wording are untouched, nothing is redrawn, and the original upload is always kept;
  - a PNG that is already transparent is used as uploaded unless the user chooses otherwise.
- **Invoices** (`views/invoices/_invoice-document.ejs`, shared by the detail page, print and PDF):
  - the image is centred above "Authorised Signatory" inside the box, at the chosen width, with its aspect ratio kept (`max-height` 38 mm, margin inside the borders);
  - the "For THE CITY CART:" heading is left out while the combined image is shown;
  - text-only box when it is off or not set; never on purchase documents;
  - the bank details and signatory box stay together across page breaks (`break-inside: avoid`);
  - the PDF embeds the image as data (like the logo), not a browser URL;
  - the stamp comes from the current business settings, so it also appears on invoices issued earlier while it is switched on.
- **Backup / restore:** files are stored in `public/uploads/logos`, which every backup archives (`uploads.tar.gz`) and restore puts back. A test backup contained both the original and the transparent file. Removing the stamp in the profile clears the setting but leaves the files on disk, so older backups and history stay intact.
- **Verified** (test copy, with a stand-in photo of a blue stamp on unevenly lit grey paper, since the real image has not been uploaded here yet), 19/19:
  - text-only before setup;
  - picking a file previews it, turns it on and drops the heading;
  - saving uses the transparent copy and keeps the original;
  - on the invoice, the image is loaded, centred above the label, inside the box with its aspect ratio kept, and there is no duplicate heading;
  - print media;
  - single-page PDF: 1 page, image embedded, heading left out; 3-page PDF: bank details and signatory together on the last page;
  - original-background mode at 40 mm;
  - switching off gives the text box; purchase bills show no stamp; Remove and Undo work.
  - Regression: build, unit 21/21, integration 20/20, invoice entry 15/15, party autofill 15/15, phone app 46/46. Invoice data, numbering and totals unchanged.
- **Real stamp applied** (at the user's request, after backup `~/vyapargst-backups/2026-11-05_113414_before-applying-stamp`):
  - `public/uploads/stamp.jpeg` was copied into managed storage (`/uploads/logos/0223144d-….jpeg`, original kept, `stamp.jpeg` left in place), and its transparent version (`…-transparent.png`, 1281×569) is printed at 50 mm, switched on, with the duplicate heading off. Only the business settings were changed; invoices were not.
  - Detection was tuned on the real photo: ink is found by colour or clear darkness, grey paper grain and creases up to 18 levels darker are ignored, and lone specks don't stop the margin trim. The checked render of INV-0029's PDF shows the stamp inside the box.
- `public/uploads/*` (outside the logos and items folders) is now git-ignored too, so photos saved there stay out of the repository.

## 16. Private "Invoice profit" panel on the sale invoice form (2026-11-05)

- **Where:**
  - desktop: in the free space under Date / Due Date on the sale invoice create and edit form;
  - phones: moved below the invoice summary.
  - Wide screens (1500px and up): moved, at the user's request, into its own card in a separate right-hand column beside the invoice (`.sale-rail`), level with the top of the invoice and sticky while scrolling. Between 992 and 1499px it stays beside the dates, because a column there would squeeze the item table.
  - Sale invoices only (not estimates, returns or purchases).
- **Privacy:**
  - hidden on every load, reload and switch of invoice, and when the page is restored from the back/forward cache. Nothing is remembered;
  - the hidden state shows "••••" with an eye button whose label is "Show profit" or "Hide profit";
  - figures are fetched from `POST /api/invoices/profit` only after the eye is clicked, and hiding removes them from the page;
  - the API checks `canViewProfit` (`src/lib/permissions.ts`: the business owner; today every user owns their business, and a staff role would need an explicit permission there), so a hidden eye is not the only protection;
  - the card has `no-print`, a print rule hides it, and the customer templates (`_invoice-document`, PDF) never include it;
  - saved costs are stripped from the edit page's embedded line data.
  - Note: the item search API already returned `purchasePrice` before this change (the purchase forms use it); restrict it if non-owner roles are added.
- **Calculation** (`src/services/profit/profitService.ts`, Decimal arithmetic, rounded to the paisa per line):
  - net sales = each line's GST-exclusive taxable value after its own discount, times the same invoice-discount ratio `calculateInvoiceTotals` uses, so it always equals the invoice's taxable item amount;
  - cost: the app has no inventory costing (stock movements carry no cost), so the cost is the item's saved purchase price, labelled an estimate. Prices entered with tax are converted to excluding GST. Purchase GST is excluded for a GST-registered business (input credit) and included for an unregistered one;
  - units: costs are per base unit; a line sold in the item's second unit is divided by the conversion rate (1 base = N second units); any other unit counts as cost missing;
  - a missing price, a ₹0 price on a product (services may be ₹0) or a typed item gives "Cost missing", never zero. The line is left out of profit and margin, which cover costed lines only, and the estimate is marked incomplete;
  - margin = estimated gross profit ÷ costed net sales × 100, or "—" when that is zero; losses are shown in red with "(loss)";
  - charges and round-off are not part of item profit and are named; "Other business expenses are not deducted";
  - updates as items, quantities, prices and discounts change (after the existing live calculation).
- **Saved costs (migration `20261105160000_invoice_line_cost`, additive):**
  - `SaleInvoiceItem.unitCost` (per unit of the line, excluding recoverable GST) and `costBasis` (`purchase-price` or `missing`) are saved on new sale invoice lines;
  - when editing, a line already on the invoice keeps its saved cost, including "none" on older invoices, so no history is invented; new lines take today's cost;
  - existing lines stay NULL. The panel then uses today's purchase prices and says "saved before costs were recorded … (estimate)";
  - backup `~/vyapargst-backups/2026-11-05_160013_before-invoice-line-cost`; applied to the test databases and the real one.
- **Verified:**
  - unit tests 7/7: % and ₹ line discounts, invoice discount spread, tax-inclusive sale and purchase prices, unregistered GST, box/piece conversion and unknown unit, missing and ₹0 costs, loss, zero sales, charges and round-off, saved cost preferred;
  - integration: saved on create, unchanged by a later price change and edits, a new typed line marked missing, no back-fill on older invoices, none on estimates; totals unchanged;
  - browser (test copy) 36/36:
    - hidden by default with no figures in the page; reveal and hide labels;
    - net sales equal the invoice's taxable amount through quantity, % and ₹ line discounts and the invoice discount; cost and margin as calculated; charges excluded;
    - cost missing and incomplete; loss; zero sales showing "—";
    - after revealing and saving: no profit on the details page source, in print, in the downloaded PDF text or in the sales CSV;
    - edit page source has no costs; reopen and reload start hidden; saved cost used on edit; older invoice labelled as an estimate;
    - no panel on estimate, purchase or return forms;
    - phone: below the summary, hidden, no sideways scroll;
    - the API refuses requests without sign-in.
  - Regression: build, unit 28/28, integration 21/21, invoice entry 15/15, party autofill, phone app 46/46, stamp 19/19.

### Fix: app stuck on "Connection required" (2026-11-05)
- **Cause:** on Android, Capacitor serves only the error page file itself (`server.errorPath`), not its separate CSS, JS or logo files. The page rendered unstyled, and its Retry and auto-retry script never loaded, so an app that started while the phone was offline stayed on that page.
- **Fix:** `scripts/build-www.mjs` now inlines the stylesheet, config, script and logo into `offline.html` and `index.html`.
- **Verified on the Android emulator** (API 35, installed with `sdkmanager`) with the rebuilt debug APK: a normal launch reaches the sign-in page at `http://192.168.1.46:3000`; starting in airplane mode shows the connection screen, and after the connection returns the app opens sign-in by itself.
- The Android SDK, emulator and JDK 21 are now installed in the user's folders (`~/Library/Android/sdk`, `~/.local/java`), with the Android SDK license accepted at the user's request, so `npm run apk:debug` works on this Mac.

## 17. AI Import Purchase Bill (2026-11-05)

Purchase Bills → **Import bill with AI**: upload → reading → editable review → **Confirm & Save Purchase**. Manual entry (New purchase) is unchanged.

### Setup (reading provider)
- **Default since section 18: free local reading** (`AI_IMPORT_PROVIDER=local`): direct parsers, Tesseract OCR and an optional local Ollama model. See [docs/purchase-import-local-setup.md](docs/purchase-import-local-setup.md).
- **Anthropic Claude (optional, paid):** used only when `AI_IMPORT_PROVIDER=anthropic` **and** `ANTHROPIC_API_KEY` are set on the server. Official SDK (`@anthropic-ai/sdk` 1.3.0), default model `claude-opus-5-5` (`AI_IMPORT_MODEL`), behind `BillExtractor` (`src/services/purchaseImport/extractor.ts`). The key never reaches browsers or the mobile app. In that mode the file content of documents that need reading is sent to Anthropic for that request (Claude Opus 5.5: $4 / $20 per million input / output tokens; a one- or two-page bill is roughly a few US cents, an estimate). Safety: document wrapped as data, strict schema, server-side refusal fallback.

### Formats (detected from content, not the extension)

| Format | How it is read |
|---|---|
| PDF | Embedded text read with pdf.js; scanned PDFs (no text layer) are rendered and read by Tesseract OCR (section 18). Password-protected or damaged files get a clear message. |
| JPG/JPEG, PNG, WEBP | Images, with camera orientation and the user's rotation applied |
| HEIC/HEIF | Converted with macOS `sips` (the bundled image library cannot decode HEIC). Elsewhere: an instruction to send JPEG instead. |
| TIFF | Up to 10 pages |
| XLSX, XLS, ODS, CSV, TSV | SheetJS: every sheet, merged headers filled, formatted values. Formulas are never calculated; one without a saved result is flagged. Macros and external links are not loaded. |
| DOCX | mammoth: tables and paragraphs; embedded pictures go to the AI |
| ODT, PPTX | ZIP/XML: tables, text, embedded pictures |
| RTF, TXT | Text and tabbed tables |
| DOC, PPT (legacy) | Converted with LibreOffice when installed (`SOFFICE_PATH`); it is **not installed here**, so these get a "save as DOCX/PPTX/PDF or install LibreOffice" message |

- **Limits:** 10 files, 15 MB each, 40 MB per upload, 50 PDF pages.
- **Refused uploads:** an unsupported file stops the upload with the reason; nothing is skipped silently.
- **Several files:** choose whether they are one bill (pages of one import) or separate bills (one import each).

### Review
- **Layout:** the original document sits beside the editable data (images can be rotated; PDFs embedded; spreadsheets and documents shown as read). Phones get Document / Details tabs.
- **Editing:**
  - every field can be edited, and rows added or deleted;
  - supplier: chosen, or created on confirm, matched by GSTIN, then exact name, with similar names suggested;
  - document type: purchase bill, or catalogue / price list / quotation, which create items only;
  - spreadsheet and table mapping: choose the sheet or table, the header row and each column.
- **Highlighted:** uncertain fields, unmatched lines, suggested matches to confirm, similar items of another size, unit conversions needed, GST rate different from the item, printed vs calculated line amounts, cost changes, possible duplicate bills, the same file uploaded before, and the total check.
- **Before you confirm:** stock added, new items, default purchase-price changes, and the bill total and outstanding (saved unpaid; payment terms on the bill are shown, never treated as payment).
- **Nothing changes before confirmation:** reading, auto-saved drafts and resuming change no stock, prices or balances.

### Matching, units, costs
- **Matching order:**
  1. this supplier's remembered item mapping;
  2. exact item code or barcode;
  3. names as suggestions only. A same name must be confirmed, and a different size or variant (e.g. 70 vs 75 GSM) is never suggested. Confirmed matches and their unit conversions are remembered (`SupplierItemMap`).
- **Units:** the item's base unit, or its second unit with its conversion rate, is used automatically. Any other bill unit (e.g. BOX for an item kept in pieces) asks "1 BOX = ? Pieces"; the purchase is then posted in base units, so stock is right.
- **Cost comparison:** per base unit, after line and bill discounts, excluding GST for a GST-registered business, against the item's saved purchase price on the same basis. Also shown: the last purchase reference and date.
- **Default purchase price:** an increase pre-ticks "Update the item's default purchase price", a decrease does not. Changes are recorded in `ProductPriceHistory`. Selling prices, older invoices and their saved cost/profit snapshots are never changed, and stock is not revalued. The purchase always records the actual bill rate.

### Validation and posting
- **Totals:** recalculated with the app's GST engine (never AI arithmetic) and compared with the printed total within ₹1.00. A larger difference must be ticked as checked.
- **Duplicates:** the same supplier plus the same invoice number (ignoring case and spacing), or the same supplier, date and total, blocks confirmation until ticked. The same file uploaded before is a warning; the same file **already confirmed as a purchase** blocks until ticked (section 18).
- **Confirm:** one transaction with a row lock, so double clicks, retries and parallel requests post once. It covers:
  - the supplier, if new;
  - new items (stock 0);
  - approved price changes and their history;
  - the remembered mappings;
  - the purchase bill through the normal purchase service (`saveDocument`, which now accepts an outer transaction): stock in, supplier balance, numbering. Round-off makes the payable equal the bill's total when per-unit conversion rounds a few paise.
- **Edit or cancel** the posted purchase from its page as usual (existing reversal rules).
- **Storage:**
  - documents are in `public/uploads/purchase-docs`, which is blocked from public access (404) and served only to the signed-in business;
  - they are included in backups (`uploads.tar.gz`); drafts are in the database dump;
  - a purchase saved from an import links to the supplier's document.

### Database
- Migration `20261105200000_purchase_import` (new tables only): `PurchaseImport`, `PurchaseImportFile`, `SupplierItemMap`, `ProductPriceHistory`.
- Backup first: `~/vyapargst-backups/2026-11-05_184503_before-purchase-import`.

### Verified
- **Unit tests (11):**
  - content detection of all 18 formats, including renamed files, OLE and ZIP containers, encrypted Office, damaged PDF and unknown binaries;
  - reading XLSX/XLS/ODS (all sheets, merged headers, formula flag), and CSV/TSV/DOCX/ODT/PPTX/RTF tables all giving the same rows;
  - text vs scanned PDF; image rotation and TIFF; real HEIC conversion on macOS; the legacy DOC LibreOffice message;
  - Indian number formats, skipping totals, rate from amount ÷ quantity;
  - matching: same name only suggested, 70 vs 75 GSM kept apart, code and remembered mapping.
- **Database tests (5, test database):**
  - reading, review blockers, conversion and new-item choices;
  - a draft changes nothing;
  - two simultaneous confirms post once; a repeat returns "already";
  - stock, the Box → Pieces line (24 at ₹10), new item, price history, unchanged selling price, unpaid balance, mappings;
  - a second import of the same bill is remembered, flagged as a duplicate and refused;
  - a price list creates items only;
  - a photo without a key gives "AI setup required"; an .exe is refused;
  - Claude extractor with a stand-in client: request shape (PDF document block, tables as data, schema format, system prompt) and schema rejection.
- **Browser (test copy, 22 checks):**
  - the Purchase Bills button; the upload page (setup notice, camera, formats); refusal of an unsupported file;
  - the Excel bill read without AI; suggested and remembered matches; summary; totals matching the printed total;
  - the draft changes nothing and resumes after reload;
  - confirm with a double click gives one purchase, stock +5 on the existing item with no duplicate item, the document linked on the bill, and the PDF working;
  - documents are not public;
  - photo: "AI setup required" and rotation;
  - phone tabs, no sideways scroll.
- **Regression:** build, unit 39/39, integration 26/26, invoice entry 15/15, phone app 46/46, profit panel 36/36.

### Not verified here / limitations
- **Live Claude reading** was not run (no Anthropic key here; tested with a stand-in client). Local reading of the real bill is verified in section 18.
- **LibreOffice is not installed,** so legacy DOC/PPT conversion is untested; DOCX, PPTX and PDF work.
- **HEIC conversion relies on macOS;** on a Linux server, phones should send JPEG.
- **Spreadsheets without recognisable headers** need the column mapping (or AI).
- **Multi-currency bills** are not handled.
- ~~The user's own upload `bill no 2626.pdf` waiting with "AI setup required"~~ — read locally in section 18.

## 18. Free local bill reading (no paid API) (2026-11-05)

The importer no longer needs Claude. Default `AI_IMPORT_PROVIDER=local`; works without `ANTHROPIC_API_KEY`; documents stay on this Mac. Setup, commands, sizes and limits: [docs/purchase-import-local-setup.md](docs/purchase-import-local-setup.md).

### Hardware and tools (checked on this Mac)
- Apple M1 MacBook Air, 8 GB RAM, 8 cores, ~28 GB free, macOS 26.6.1.
- Tesseract 5.5.3 (Apache-2.0, already installed; eng + osd). poppler 26.10.0 `pdftoppm` (installed with brew). Ollama 0.40.13 (MIT, installed with brew).
- Local model `granite3.3:2b` (IBM Granite 3.3, Apache-2.0, 2.5B, Q4_K_M, 1.55 GB download, 2.0 GB loaded). Rejected: `qwen2.5:3b` (Qwen licence, not Apache/MIT), `phi4-mini` (licence not stated on its Ollama page, 2.5 GB), 7–8B models (too heavy for 8 GB next to the app and PostgreSQL).

### How a bill is read (`extractImport`, each step reported on the review screen)
1. **Layout:** words with positions from the PDF text layer (`layout.ts → pdfLayout`), or from Tesseract word boxes (`ocrImage`, `--psm 6`, TSV with confidence) for photos and scanned PDFs (pages rendered with `pdftoppm` at 300 dpi; `sips` for one page without poppler). OCR coordinates are scaled to a 595-pt page; words are grouped by Tesseract's own line ids, so slightly tilted photos keep their rows; stuck-on table marks are cleaned (`1)Index`, `93.22]`, `4Pcs`).
2. **Rule parser** (`ruleParser.ts`), for Tally-style and similar GST invoices:
   - **Supplier:** the seller block (name, address, phone, GSTIN other than the business's own; "for NAME" signature). OCR GSTINs are repaired by position (O/0, I/1, S/5) only when the GSTIN check digit confirms it.
   - **Invoice details:** label/value pairs (Invoice No., Dated). When the label can't be read, the number next to the date is used (never from Ack/IRN/e-way lines) and flagged.
   - **Item table:** columns from the header (also headers split over 2–3 lines; "Rate (Incl. of Tax)" vs rate). Each line must satisfy qty × rate (− disc) = amount; if not, the printed numbers that do are used (a misplaced discount or lost decimal point is detected and flagged).
   - **Totals:** CGST/SGST/IGST, round-off, charges and the grand total; reading stops at "Amount chargeable" and the HSN summary. GST rates come from the HSN summary when lines don't show them. An unlabelled total is accepted only if it equals items + taxes + round-off.
   - It never fills a value it did not find; doubtful ones are listed as uncertain.
3. **Optional local AI** (`localAi.ts`), only when the parser found no rows, the totals don't reconcile, or the supplier or invoice number is missing, and Ollama is running locally. JSON-schema structured output, temperature 0, 4-minute timeout. Its answer is grounded:
   - numbers, GSTIN, HSN, invoice number (not Ack/IRN) and dates that are not printed are removed and flagged;
   - lines whose qty × rate isn't their amount are flagged; invented lines are dropped.
   - Its rows replace the parser's only when the parser had none, or when its rows add up and the parser's didn't.
4. **Claude** only if explicitly chosen (`AI_IMPORT_PROVIDER=anthropic` + key).

### Review behaviour added
- **Unmatched lines:** prepared as **new items** (`autoNew`), created only on confirmation and changeable to a match. When a remembered or exact-code match appears later (e.g. after choosing the supplier), they switch to it; a user's own "create" stays.
- **Never a fake success:** "How this bill was read" lists every step (ok / failed / not available, with the reason and command). With no rows it says "No item lines could be read automatically", keeps everything found, and the status is DRAFT. It is NEEDS_SETUP only when OCR itself is missing.
- **Read again (keeps your edits):** re-runs the reading without re-uploading. Header fields and rows you changed or added stay, deleted rows stay deleted, and untouched ones take the new reading (`sourceData.machineDraft`). Fixed: for an import that had no earlier reading, lines typed by hand were kept but the newly read lines were dropped. Now both are kept, with a note to delete duplicates.
- **Duplicate protection:**
  - the same file already confirmed as a purchase now blocks until ticked;
  - the duplicate check also runs when the supplier is found by exact GSTIN but not yet chosen;
  - bill dates are compared as local calendar days (they were compared in UTC, a day early for IST);
  - confirmation never creates a second party with the same GSTIN.
- **Same-name new items:** when a bill prints the same name for different variants (this bill has five "Ex-Note Book" lines at different rates), confirmation is blocked until each new item gets a distinct name; names are never invented.
- **Setup panel** (`views/purchase-import/_services.ejs`, `GET /api/purchase-imports/status`): the live status of OCR, page rendering and local AI, with the exact Mac commands, model size and memory, and the phone note.

### Verified
- **The real supplier bill** `bill no 2626.pdf` (SEHGAL ENTERPRISES, Tally e-invoice) on the test copy, through the review screen. All three forms give the same result:

  | Form | Time |
  |---|---|
  | Text PDF | 3 s |
  | Scanned PDF (rendered image, no text layer, OCR) | 7 s |
  | Tilted, blurred phone-style photo | 4 s |

  - **Supplier:** SEHGAL ENTERPRISES, GSTIN 05ASNPS0578E1ZI (OCR read "OSASNPSO578E1Z1"; corrected via the check digit), phone 0135-2652661, address.
  - **Invoice:** 26-27/2626 dated 2026-11-04.
  - **All 12 items** with HSN, quantity, unit, rate excluding tax, GST 18% / 0% (exempt) and amount.
  - **Totals:** round-off 0.06; calculated total ₹9,891.00 equals the printed ₹9,891.00.
  - Blockers left: confirming the 3 suggested matches, and naming the five "Ex-Note Book" new items apart.
  - On the photo, OCR misread the printed subtotal (9782.38); this was detected and noted because the lines plus taxes give the printed total.
- **Local AI forced** on the photo's OCR text: 152 s, 2.0 GB, 100% GPU. It was poor on numbers (rates including tax, GST 9%, a 2022 date), which led to the date and qty × rate grounding. It is documented as a weak fallback.
- **Real database,** extraction only, on the user's import `79450ee8…` (backup of the row first: scratchpad `backup_import_79450ee8.json`):
  - now DRAFT with 12 rows; ₹9,891 calculated = printed;
  - the user's earlier typed invoice number "2626" kept;
  - blocked as "same file already confirmed".
  - Record counts before and after were identical (invoices 39, items 95, parties 13, mappings 1). Nothing posted.
- **Tests:**
  - unit 49/49 (new `ruleParser.test.ts`: the Tally layout, no invented rows, OCR column drift, GSTIN check/repair, OCR word clean-up, dates, AI grounding);
  - integration 28/28 (new: an OCR'd bill image read end to end; re-read keeps edits and deletions; a photo with nothing readable gives an honest no-rows draft and Claude is not called even with a key present; manual-plus-read merge);
  - browser import flow 24/24 (test copy); browser flows passed; mobile env 3/3; build OK.

### Found during verification (not changed by me)
- **The real database has purchase `PB-0001`** (SEHGAL ENTERPRISES, ref 26-27/2626, ₹1,100.06 unpaid, **1 line**: Index File PVC 10 × ₹110 incl. tax), confirmed from import `16b8f6c1…` on 2026-11-05 15:45 UTC.
  - **Cause:** that import's draft held only one hand-typed line, because of the re-read merge bug fixed above.
  - **Its effects:** it created the supplier SEHGAL ENTERPRISES, added +10 stock to Index File PVC, and remembered one mapping; no price changed.
  - **Left as is:** it is the user's own record, and whether to edit it (add the other 11 lines) or cancel it is the user's decision.

### Limits
- Handwritten bills, dark or very blurred photos, multi-column or unusual layouts may give few or no rows; the screen says so and keeps what was found.
- One real supplier layout (Tally) was verified; other layouts are covered by the generic header and column logic and by tests, not by real bills.
- The local AI is slow and weak on 8 GB.
- Hindi OCR needs `tesseract-lang`.


## 19. Orange theme (2026-11-05)

The visual theme changed from indigo/violet to a warm orange. Layout, behaviour, data, and invoice print/PDF are unchanged.
- **Tokens** (`public/css/app.css` `:root`): an `--accent-50…900` orange scale (#FFF7ED to #7C2D12) and the signature gradient `--grad` (#F97316 → #EA580C).
  - Warm stone neutrals: page `#F9F6F1`, white surfaces, charcoal text `#1C1917`.
  - Warm shadows; an orange focus ring.
  - Bootstrap primary is `#C2410C`.
- **Contrast:** white text sits only on ≥ 4.5:1 orange. Primary buttons use `#CF480B → #B93D0B` (4.58–5.62:1), and orange text is `#C2410C` or darker. The bright #F97316 → #EA580C gradient is used only decoratively (active nav icon and bar, section markers, brand marks, banners).
- **Sidebar:** warm charcoal with an orange glow and an orange active item; light warm text.
- **Unchanged meanings:** green (success), red (errors and destructive actions) and amber (warnings) keep their colours. Info alerts moved to sky blue, so they are not confused with warnings.
- **Elsewhere:** the `theme-color` meta, the login page, and the mobile app's connection/offline screen (rebuilt and synced to Android and iOS with the same server URL, `192.168.1.46:3000`).
- **Not changed:** the invoice and report print templates (self-contained), the `@media print` rules (identical), and the stamp preview.
- **Verified** on the test copy:
  - a computed-colour scan of 11 pages, a dropdown, a dialog and 3 phone screens found 0 leftover blue/purple and 0 page errors;
  - build OK; unit 49/49, integration 28/28, mobile 3/3, browser flows 15/15.
