// Admin action log. Every admin change (and automatic ones like ABN re-checks) is recorded,
// which helps if a removal is ever disputed.
import { query } from '../db.js';

/**
 * logAction(req.user | null, 'suspend_user', { type: 'user', id: 12 }, 'Suspended Jane Citizen (customer)', note)
 * Pass null as the actor for automatic jobs (shown as "System").
 */
export async function logAction(actor, action, target, summary, note = null) {
  try {
    await query(
      `INSERT INTO admin_actions (admin_id, admin_name, action, target_type, target_id, summary, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor?.id || null, actor?.name || 'System', action, target?.type || null, target?.id || null, summary, note || null]
    );
  } catch (err) {
    console.error('Could not write to the admin log:', err.message);
  }
}
