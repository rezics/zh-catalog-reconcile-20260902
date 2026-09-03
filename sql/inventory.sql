with public_books as materialized (
	select
		u.id,
		u.created_at,
		coalesce(
			array_agg(distinct l.language order by l.language)
				filter (where l.language is not null),
			array[]::text[]
		) as languages
	from unit u
	join book b on b.id = u.id
	left join unit_localization l on l.unit_id = u.id
	where u.kind = 'book'
		and u.status = 'published'
		and u.visibility = 'public'
		and u.moderation_status = 'approved'
		and u.deleted_at is null
		and u.created_at <= $1::timestamptz
	group by u.id, u.created_at
), language_distribution as (
	select languages, count(*)::bigint as count
	from public_books
	group by languages
)
select jsonb_build_object(
	'publicBooks', (select count(*)::bigint from public_books),
	'exactZhSources', (
		select count(*)::bigint from public_books where languages = array['zh']::text[]
	),
	'withJapaneseMetadata', (
		select count(*)::bigint from public_books where 'ja' = any(languages)
	),
	'withNoMetadataLocalization', (
		select count(*)::bigint from public_books where cardinality(languages) = 0
	),
	'earliestSourceCreatedAt', (
		select min(created_at) from public_books where languages = array['zh']::text[]
	),
	'latestSourceCreatedAt', (
		select max(created_at) from public_books where languages = array['zh']::text[]
	),
	'languageSets', (
		select coalesce(
			jsonb_agg(
				jsonb_build_object('languages', languages, 'count', count)
				order by count desc, languages
			),
			'[]'::jsonb
		)
		from language_distribution
	)
) as inventory;
