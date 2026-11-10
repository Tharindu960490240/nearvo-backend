// Daily jobs, run by the Vercel cron (see vercel.json) or from the admin page:
//  1. Re-check tradies' ABNs with the ABR, oldest check first, and pause anyone whose ABN is no longer active.
//  2. Email the admin a short summary of the last 24 hours.
import { query } from '../db.js';
import { abrEnabled, lookupBusinessNumber } from './abr.js';
import { getAlerts } from './alerts.js';
import { logAction } from './audit.js';
import { appUrl, escapeHtml, sendMail } from './mailer.js';
import { emailButton, emailColors, renderEmail } from './emailTemplate.js';

const RECHECK_DAYS = 30;     // every tradie is re-checked at least this often
const BATCH = 40;            // per run, so one run stays well inside the function time limit

/** Re-checks one tradie. Returns 'ok' | 'paused' | 'skipped'. */
export async function recheckTradieAbn(tradie, actor = null) {
  try {
    const r = await lookupBusinessNumber(tradie.abn, { fresh: true });
    await query(
      `UPDATE tradie_profiles SET abn_checked_at = now(), abn_status = $2, abn_entity_name = COALESCE($3, abn_entity_name) WHERE user_id = $1`,
      [tradie.user_id, r.status, r.entity_name]
    );
    return 'ok';
  } catch (err) {
    if (!['ABN_INACTIVE', 'ABN_NOT_FOUND', 'ABN_MISSING'].includes(err.code)) return 'skipped'; // ABR down etc. - try again next time
    const status = (/status: ([^)]+)\)/.exec(err.message) || [])[1] || 'Not found';
    await query(
      `UPDATE tradie_profiles SET abn_checked_at = now(), abn_status = $2, suspended_at = COALESCE(suspended_at, now()),
              paused_reason = 'ABN no longer active (ABR check)' WHERE user_id = $1`,
      [tradie.user_id, status.slice(0, 20)]
    );
    await logAction(actor, 'abn_pause', { type: 'user', id: tradie.user_id },
      `Paused ${tradie.business_name}: ABN ${tradie.abn} is no longer active (${status})`);
    if (tradie.email) {
      await sendMail({
        to: tradie.email,
        subject: 'Your Nearvo profile has been paused',
        text: `Hi ${tradie.name},\n\nWe re-checked your ABN (${tradie.abn}) with the Australian Business Register and it is no longer active (${status}). Tradies need an active ABN to be listed, so your profile is hidden for now.\n\nIf you have a new ABN, add it in your profile: ${appUrl()}/tradie/profile\nIf you think this is a mistake, reply to this email.\n\nNearvo`,
      }).catch(() => {});
    }
    return 'paused';
  }
}

export async function recheckAbns({ limit = BATCH } = {}) {
  if (!abrEnabled()) return { enabled: false, checked: 0, paused: 0, skipped: 0 };
  const { rows } = await query(
    `SELECT tp.user_id, tp.abn, tp.business_name, u.name, u.email FROM tradie_profiles tp JOIN users u ON u.id = tp.user_id
     WHERE tp.abn IS NOT NULL AND tp.abn_check <> 'demo' AND tp.suspended_at IS NULL AND u.suspended_at IS NULL
       AND (tp.abn_checked_at IS NULL OR tp.abn_checked_at < now() - make_interval(days => $1))
     ORDER BY tp.abn_checked_at NULLS FIRST LIMIT $2`,
    [RECHECK_DAYS, limit]
  );
  const result = { enabled: true, checked: 0, paused: 0, skipped: 0 };
  for (const t of rows) {
    const r = await recheckTradieAbn(t);
    if (r === 'skipped') result.skipped += 1;
    else result.checked += 1;
    if (r === 'paused') result.paused += 1;
  }
  return result;
}

export async function buildSummary() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE role = 'customer' AND created_at > now() - interval '24 hours') AS new_customers,
      (SELECT COUNT(*)::int FROM users WHERE role = 'tradie' AND created_at > now() - interval '24 hours') AS new_tradies,
      (SELECT COUNT(*)::int FROM jobs WHERE created_at > now() - interval '24 hours') AS new_jobs,
      (SELECT COUNT(*)::int FROM quotes WHERE created_at > now() - interval '24 hours') AS new_quotes,
      (SELECT COUNT(*)::int FROM jobs WHERE completed_at > now() - interval '24 hours') AS completed_jobs,
      (SELECT COUNT(*)::int FROM reviews WHERE created_at > now() - interval '24 hours') AS new_reviews,
      (SELECT COUNT(*)::int FROM reports WHERE status = 'open') AS open_reports,
      (SELECT COUNT(*)::int FROM reports WHERE created_at > now() - interval '24 hours') AS new_reports`);
  return { counts: rows[0], alerts: await getAlerts() };
}

export async function sendDailySummary(abn = null) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return { sent: false, reason: 'ADMIN_EMAIL is not set' };
  const { counts: c, alerts } = await buildSummary();
  const needs = c.open_reports + alerts.length;
  const subject = needs
    ? `Nearvo daily: ${c.open_reports} report${c.open_reports === 1 ? '' : 's'} open, ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`
    : 'Nearvo daily: nothing needs you today';
  const lines = [
    ['New customers', c.new_customers], ['New tradies', c.new_tradies], ['Jobs posted', c.new_jobs],
    ['Quotes sent', c.new_quotes], ['Jobs completed', c.completed_jobs], ['Reviews', c.new_reviews],
    ['New reports', c.new_reports], ['Reports waiting', c.open_reports],
  ];
  const abnLine = abn?.enabled ? `ABN re-check: ${abn.checked} checked, ${abn.paused} paused${abn.skipped ? `, ${abn.skipped} to retry` : ''}.` : '';
  const text = `Last 24 hours on Nearvo\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`
    + (alerts.length ? `Needs a look:\n${alerts.map((a) => `- ${a.title}`).join('\n')}\n\n` : 'Nothing needs a look.\n\n')
    + (abnLine ? `${abnLine}\n\n` : '') + `Admin: ${appUrl()}/dashboard`;
  const C = emailColors;
  const cell = ([k, v], i) => `<td width="25%" style="padding:12px 8px;text-align:center;border:1px solid ${C.line};background:${C.soft}">
      <div style="font-size:22px;font-weight:800;color:${k === 'Reports waiting' && v ? '#b26a00' : C.ink}">${v}</div>
      <div style="font-size:12px;color:${C.muted}">${k}</div></td>`;
  const rows = [lines.slice(0, 4), lines.slice(4, 8)].map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('');
  const html = renderEmail({
    title: needs ? 'A few things need a look' : 'All quiet on Nearvo',
    preheader: subject,
    bodyHtml: `<p style="margin:0 0 16px;color:${C.muted}">Here's what happened in the last 24 hours.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px">${rows}</table>
      ${alerts.length
        ? `<h2 style="margin:6px 0 8px;font-size:17px">Needs a look</h2><ul style="margin:0 0 12px;padding-left:20px">${alerts.map((a) => `<li style="margin:0 0 6px">${escapeHtml(a.title)}<br><span style="font-size:13px;color:${C.muted}">${escapeHtml(a.text)}</span></li>`).join('')}</ul>`
        : `<p style="margin:0 0 12px">✅ No unusual activity: spam, scam and overdue-report checks all look fine.${c.open_reports ? ` You have <b>${c.open_reports} report${c.open_reports === 1 ? '' : 's'}</b> to review in the inbox.` : ''}</p>`}
      ${abnLine ? `<p style="margin:0 0 12px;font-size:14px;color:${C.muted}">${escapeHtml(abnLine)}</p>` : ''}
      ${emailButton('Open the admin dashboard', `${appUrl()}/dashboard`)}`,
  });
  await sendMail({ to, subject, text, html });
  return { sent: true, subject };
}

/** Everything the daily cron does. */
export async function runDaily() {
  const abn = await recheckAbns();
  const summary = await sendDailySummary(abn);
  return { abn, summary };
}
