// "Needs a look" list for the admin: possible spam, scams and overdue work. Read-only checks.
import { query } from '../db.js';

export async function getAlerts() {
  const [jobFlood, sameQuote, sharedPhone, multiReports, overdue, abnPaused] = await Promise.all([
    // Customers posting lots of jobs in a day
    query(`SELECT u.id, u.name, u.email, COUNT(*)::int AS n
           FROM jobs j JOIN users u ON u.id = j.customer_id
           WHERE j.created_at > now() - interval '24 hours' AND u.suspended_at IS NULL
           GROUP BY u.id HAVING COUNT(*) >= 5 ORDER BY n DESC LIMIT 20`),
    // Tradies sending the same quote message to many jobs (copy-paste spam)
    query(`SELECT u.id, u.name, tp.business_name, COUNT(*)::int AS n
           FROM quotes q JOIN users u ON u.id = q.tradie_id JOIN tradie_profiles tp ON tp.user_id = u.id
           WHERE q.created_at > now() - interval '7 days' AND length(coalesce(q.message, '')) > 0 AND u.suspended_at IS NULL
           GROUP BY u.id, tp.business_name, lower(trim(q.message)) HAVING COUNT(*) >= 5 ORDER BY n DESC LIMIT 20`),
    // One phone number used by several accounts
    query(`SELECT phone, COUNT(*)::int AS n, json_agg(json_build_object('id', id, 'name', name, 'role', role) ORDER BY id) AS users
           FROM users WHERE phone IS NOT NULL AND suspended_at IS NULL
           GROUP BY phone HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 20`),
    // Items reported by more than one person
    query(`SELECT target_type, target_id, COUNT(*)::int AS n FROM reports
           WHERE status = 'open' AND target_id IS NOT NULL
           GROUP BY target_type, target_id HAVING COUNT(*) >= 2 ORDER BY n DESC LIMIT 20`),
    // Reports waiting more than 5 days
    query(`SELECT COUNT(*)::int AS n FROM reports WHERE status = 'open' AND created_at < now() - interval '5 days'`),
    // Tradies paused by the automatic ABN re-check in the last week
    query(`SELECT tp.user_id AS id, tp.business_name, tp.abn, tp.abn_status FROM tradie_profiles tp
           WHERE tp.suspended_at > now() - interval '7 days' AND tp.paused_reason LIKE 'ABN%' ORDER BY tp.suspended_at DESC LIMIT 20`),
  ]);

  const alerts = [];
  for (const r of jobFlood.rows) {
    alerts.push({ level: 'warning', kind: 'job_flood', title: `${r.name} posted ${r.n} jobs in 24 hours`, text: 'Could be spam or a fake account.', user_id: r.id });
  }
  for (const r of sameQuote.rows) {
    alerts.push({ level: 'warning', kind: 'same_quote', title: `${r.business_name} sent the same quote message ${r.n} times this week`, text: 'Copy-paste quotes can be spam.', user_id: r.id });
  }
  for (const r of sharedPhone.rows) {
    alerts.push({ level: 'warning', kind: 'shared_phone', title: `${r.n} accounts use the phone number ${r.phone}`, text: r.users.map((u) => `${u.name} (${u.role})`).join(', '), user_id: r.users[0].id, phone: r.phone });
  }
  for (const r of multiReports.rows) {
    alerts.push({ level: 'error', kind: 'multi_reports', title: `A ${r.target_type} was reported by ${r.n} people`, text: 'Open the Reports inbox to review it.', link: '/admin/reports' });
  }
  if (overdue.rows[0].n > 0) {
    alerts.push({ level: 'error', kind: 'overdue', title: `${overdue.rows[0].n} report${overdue.rows[0].n > 1 ? 's have' : ' has'} waited more than 5 days`, text: 'Aim to respond to complaints quickly.', link: '/admin/reports' });
  }
  for (const r of abnPaused.rows) {
    alerts.push({ level: 'info', kind: 'abn_paused', title: `${r.business_name} was paused automatically`, text: `ABN ${r.abn} is no longer active (${r.abn_status || 'not found'}).`, user_id: r.id });
  }
  return alerts;
}
