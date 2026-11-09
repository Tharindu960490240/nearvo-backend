// Shared SQL for tradie summaries (used by search, profile and quote lists).
// `distanceFrom` is an optional [latParam, lngParam] pair of SQL placeholders.
export function tradieSelect(distanceFrom) {
  const dist = distanceFrom ? `km_between(${distanceFrom[0]}::float8, ${distanceFrom[1]}::float8, s.latitude, s.longitude)` : 'NULL::float8';
  return `
    SELECT u.id, tp.business_name, tp.bio, tp.years_experience, tp.photo_url, tp.abn, tp.licence_number,
           tp.abn_entity_name, tp.abn_gst_registered, (tp.abn_check = 'abr') AS abn_active,
           tp.avg_rating::float AS avg_rating, tp.review_count, tp.service_radius_km, tp.created_at,
           s.id AS suburb_id, s.name AS suburb, s.state, s.postcode, s.latitude, s.longitude,
           ${dist} AS distance_km,
           (SELECT COUNT(*)::int FROM jobs j WHERE j.assigned_tradie_id = u.id AND j.status = 'completed') AS jobs_completed,
           COALESCE(
             (SELECT json_agg(json_build_object('category_id', c.id, 'name', c.name, 'slug', c.slug, 'icon', c.icon,
                                                'price_from', ts.price_from::float, 'price_unit', ts.price_unit) ORDER BY c.name)
              FROM tradie_services ts JOIN categories c ON c.id = ts.category_id WHERE ts.tradie_id = u.id),
             '[]'::json) AS services
    FROM tradie_profiles tp
    JOIN users u ON u.id = tp.user_id
    JOIN suburbs s ON s.id = tp.suburb_id`;
}

/** Recalculates a tradie's average rating from their visible reviews. */
export const recomputeRatingSql = `
  UPDATE tradie_profiles SET
    avg_rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE tradie_id = $1 AND hidden_at IS NULL), 0),
    review_count = (SELECT COUNT(*) FROM reviews WHERE tradie_id = $1 AND hidden_at IS NULL)
  WHERE user_id = $1`;
