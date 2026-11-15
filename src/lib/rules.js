// The rules that apply to a resource: its own rule set if it has one,
// otherwise the tenant-wide settings. A NULL value means "not enforced".
export async function effectiveRules(db, tenantId, resourceId) {
  const own = await db.query(
    `SELECT min_lead_minutes, max_horizon_minutes, min_cancel_notice_minutes
       FROM resource_rules
      WHERE resource_id = $1 AND tenant_id = $2`,
    [resourceId, tenantId],
  );
  if (own.rowCount > 0) return own.rows[0];

  const shared = await db.query(
    `SELECT min_lead_minutes, max_horizon_minutes, min_cancel_notice_minutes
       FROM tenant_settings
      WHERE tenant_id = $1`,
    [tenantId],
  );
  return (
    shared.rows[0] ?? {
      min_lead_minutes: null,
      max_horizon_minutes: null,
      min_cancel_notice_minutes: null,
    }
  );
}