/**
 * ConnectorModule — 018-SETUP scaffold.
 *
 * The DP2 side of **Connector Boundary Hardening** (feature 018): the auth /
 * identity boundary the ERPNext connector (separate repo, ADR 0008) crosses to
 * reach the 012 posting-feed contract. The connector authenticates with the
 * **machine** `connectorBearer` scheme (opaque-revocable, tenant-scoped) — NOT
 * the human `cookieAuth`/`DashboardAuthGuard` (013/014) and NOT the POS
 * `clerkJwt`/device scheme (010). This module owns that connector-identity
 * surface; it is auth/identity and therefore lives at the api root, NOT under
 * `catalog/`.
 *
 * This is the foundational empty slice (the 015/017 SETUP precedent): no
 * controllers, providers, or routes yet — just a registered, compiling module
 * so the DI graph + build stay green. The connector-auth guard, token model,
 * and any boundary routes land in their own later slices.
 */
import { Module } from "@nestjs/common";

@Module({})
export class ConnectorModule {}
