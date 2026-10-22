-- Migrate original homepage content to Supabase
-- Run this once to preserve existing photos/reviews/team/contacts

-- Insert original moments photos
INSERT INTO homepage_moments (client_id, image_url, caption, sort_order, enabled)
VALUES
  ('shata', '/assets/moments/moment-1.webp', 'Graduation celebration', 1, true),
  ('shata', '/assets/moments/moment-2.webp', 'Group photo', 2, true),
  ('shata', '/assets/moments/moment-3.webp', 'Awards ceremony', 3, true),
  ('shata', '/assets/moments/moment-4.webp', 'Class photo', 4, true),
  ('shata', '/assets/moments/moment-5.webp', 'Achievement day', 5, true)
ON CONFLICT DO NOTHING;

-- Insert original parent reviews
INSERT INTO homepage_reviews (client_id, parent_name, review_text, sort_order, enabled)
VALUES
  ('shata', 'Om Malak', 'My daughter improved tremendously. The explanations are clear and the practice materials really helped her understand physics concepts.', 1, true),
  ('shata', 'Abu Ahmed', 'Excellent teaching methods. My son went from struggling to getting top marks. The recorded sessions are very helpful for review.', 2, true),
  ('shata', 'Om Yasmine', 'Very organized and professional. The online platform makes it easy to track homework and progress. Highly recommended.', 3, true),
  ('shata', 'Abu Sara', 'Great support and follow-up. Teacher really cares about student success. The materials are comprehensive and well structured.', 4, true)
ON CONFLICT DO NOTHING;

-- Update Ayten contact with full details
UPDATE homepage_contacts
SET
  phone = '201206620028',
  email = 'info@reemshataphysics.com'
WHERE client_id = 'shata' AND name = 'Ayten Ismail';
