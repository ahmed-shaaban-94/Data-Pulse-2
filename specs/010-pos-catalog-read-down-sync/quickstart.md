# Quickstart — 010 POS Catalogue Read-Down Sync

How a POS terminal (POS-Pulse 010) consumes this platform API to build and maintain its offline replica. Illustrative flow; the authoritative contract is the gated `packages/contracts/openapi/catalog/read-down.yaml`.

## 1. Baseline — fetch a snapshot

```
GET /api/pos/v1/catalog/snapshot
Authorization: <device token>        # device principal; scope = (tenant, store)
Accept-Encoding: gzip
```
- Returns the full resolved **sellable** catalogue for the device's store (paginated via `next_page_token`, all pages at one consistent cursor).
- Response carries `cursor` (opaque). The terminal writes the rows into its local replica and **stores the cursor**.
- Unpriced products are **absent** (not an error).

## 2. Stay current — fetch deltas

```
GET /api/pos/v1/catalog/deltas?since=<stored cursor>
Authorization: <device token>
```
- Returns ordered `upsert` / `remove_from_sellable` ops + an advanced `cursor`.
- Terminal applies: `upsert` → write/replace the row; `remove_from_sellable` → drop the row from the sellable replica. Stores the new cursor.
- **Idempotent**: re-requesting the same `since` is safe.

## 3. Re-baseline — when the cursor is too old

```
GET /api/pos/v1/catalog/deltas?since=<very old cursor>
→ snapshot_required
```
- Terminal discards its cursor and goes back to step 1 (fresh snapshot).

## 4. Isolation (always)

- Any attempt to fetch another store/tenant's catalogue (via `branch_id` param or a foreign cursor) → non-disclosing 404-class. The terminal only ever sees its own `(tenant, store)`.

## POS-Pulse v1 note

POS-Pulse 010 v1 MAY do **step 1 only** (snapshot), store the cursor, and defer steps 2–3 (delta application) to a POS-Pulse v2 slice. The platform contract still ships snapshot **+** delta from v1; the consumer's v1 cut does not narrow it.

## Money on the wire

```json
"price": { "amount": "12.50", "currency_code": "EGP" }
```
- Exact-decimal string at natural minor precision; POS-Pulse converts to integer minor units by string arithmetic (×100 for EGP), never float. A sellable row's price is always representable (the platform filters out the rest).
