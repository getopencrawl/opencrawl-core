/** Runtime capabilities shipped by the supported single-tenant distribution.
 *
 * Both provider catalogs built by self-host services use this single set, so
 * the UI, onboarding and connector setup all agree on which sources this
 * runtime can actually index. The permission-enforcing Drive and Linear source
 * adapters are installed here; older runtime adapters omit them and must keep
 * the catalog's explicit unavailable notice instead. This describes only
 * capabilities bundled in core, not any hosted entitlement or account. */
export const selfhostProviderCapabilities = {driveWorkspaceAccess: true, linearPublicAccess: true} as const;
