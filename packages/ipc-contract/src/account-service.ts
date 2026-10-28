import type { Entitlements } from '@app/specs/entitlements-snapshot.spec';

// The account as the `account.*` procedures and `requireFeature` see it (Phase 4; spec
// `entitlements-snapshot.spec.ts`; acceptance `entitlements-client.feature.md`, Router). Main
// implements it over its `EntitlementsReader` (`apps/desktop/src/main/account/entitlements.ts`); this
// package only knows the interface. Task 5 extends it with the sign-in flow. Tokens stay in main: no
// member answers a token, code, verifier or snapshot string.

export interface AccountService {
  /** The verified entitlements now (`EntitlementsSchema`), never the snapshot they came from. */
  entitlements(): Entitlements;
}
