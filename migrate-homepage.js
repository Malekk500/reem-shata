// One-time migration script to import existing homepage content into Supabase
// Run once in browser console while logged in as admin

async function migrateHomepageContent() {
  const SITE_CLIENT_ID = 'shata';

  // Check if already migrated
  const { data: existingMoments } = await supabase
    .from('homepage_moments')
    .select('id')
    .eq('client_id', SITE_CLIENT_ID)
    .limit(1);

  if (existingMoments && existingMoments.length > 0) {
    console.log('Migration already run. Skipping to avoid duplicates.');
    return;
  }

  console.log('Starting migration...');

  // 1. Migrate moments (5 photos)
  const moments = [
    { image_url: 'assets/moments/moment-1.webp', caption: 'Moment 1', sort_order: 1 },
    { image_url: 'assets/moments/moment-2.webp', caption: 'Moment 2', sort_order: 2 },
    { image_url: 'assets/moments/moment-3.webp', caption: 'Moment 3', sort_order: 3 },
    { image_url: 'assets/moments/moment-4.webp', caption: 'Moment 4', sort_order: 4 },
    { image_url: 'assets/moments/moment-5.webp', caption: 'Moment 5', sort_order: 5 }
  ];

  for (const m of moments) {
    await supabase.from('homepage_moments').insert({
      client_id: SITE_CLIENT_ID,
      ...m
    });
  }
  console.log('✓ Migrated moments');

  // 2. Migrate reviews (25 images)
  const reviews = Array.from({length: 25}, (_, i) => ({
    client_id: SITE_CLIENT_ID,
    image_url: `assets/reviews/review-${i + 1}.jpg`,
    enabled: true,
    sort_order: i + 1
  }));

  await supabase.from('homepage_reviews').insert(reviews);
  console.log('✓ Migrated reviews');

  // 3. Migrate team (8 members)
  const team = [
    { name: 'Ali Kandil', slug: 'ali-kandil', photo_url: 'assets/team/ali-kandil.jpg', bio: 'Team member', enabled: false, sort_order: 1 },
    { name: 'Ayten Ismail', slug: 'ayten-ismail', photo_url: 'assets/team/ayten-ismail.jpg', bio: 'Assistant teacher passionate about helping students excel in physics.', enabled: true, sort_order: 2 },
    { name: 'Ossama Hany', slug: 'ossama-hany', photo_url: 'assets/team/ossama-hany.jpg', bio: 'Team member', enabled: false, sort_order: 3 },
    { name: 'Zain Abed', slug: 'zain-abed', photo_url: 'assets/team/zain-abed.jpg', bio: 'Team member', enabled: false, sort_order: 4 },
    { name: 'Lina Waleed', slug: 'lina-waleed', photo_url: 'assets/team/lina-waleed.jpg', bio: 'Team member', enabled: false, sort_order: 5 },
    { name: 'Mariam Alaa', slug: 'mariam-alaa', photo_url: 'assets/team/mariam-alaa.jpg', bio: 'Team member', enabled: false, sort_order: 6 },
    { name: 'Noor Sherif', slug: 'noor-sherif', photo_url: 'assets/team/noor-sherif.jpg', bio: 'Team member', enabled: false, sort_order: 7 },
    { name: 'Yusuf Amr', slug: 'yusuf-amr', photo_url: 'assets/team/yusuf-amr.jpg', bio: 'Team member', enabled: false, sort_order: 8 }
  ];

  for (const t of team) {
    await supabase.from('homepage_team').upsert({
      client_id: SITE_CLIENT_ID,
      ...t
    }, { onConflict: 'client_id,slug' });
  }
  console.log('✓ Migrated team');

  // 4. Update contacts (Ayten already exists, update others to disabled)
  await supabase.from('homepage_contacts')
    .update({ enabled: true })
    .eq('client_id', SITE_CLIENT_ID)
    .eq('name', 'Ayten Ismail');

  console.log('✓ Migration complete!');
}

// Run it
migrateHomepageContent().catch(console.error);
