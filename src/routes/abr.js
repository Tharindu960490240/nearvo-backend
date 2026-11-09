// GET /api/abr/lookup?number=...  - live ABN/ACN check used by the sign-up and profile forms.
// The ABR GUID stays on the server; the browser only ever talks to this endpoint.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { lookupBusinessNumber } from '../lib/abr.js';

const router = Router();
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many lookups, please wait a few minutes' } });

router.get('/lookup', limiter, async (req, res) => {
  try {
    const r = await lookupBusinessNumber(req.query.number);
    res.json({
      abn: r.abn, acn: r.acn, status: r.status, entity_name: r.entity_name, entity_type: r.entity_type,
      gst_registered: Boolean(r.gst_from), state: r.state, postcode: r.postcode, business_names: r.business_names, source: r.source,
    });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    throw err;
  }
});

export default router;
