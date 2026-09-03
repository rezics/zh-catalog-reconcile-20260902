with requested_ids as materialized (
	select value::uuid as id
	from jsonb_array_elements_text($1::jsonb) as requested(value)
), selected as materialized (
	select
		u.id,
		u.created_at,
		u.updated_at,
		u.published_at,
		u.status::text as status,
		u.visibility::text as visibility,
		u.moderation_status::text as moderation_status,
		u.content_rating,
		u.ai_disclosure,
		b.release_status,
		b.isbn13,
		b.publication_date,
		b.page_count,
		b.word_count
	from requested_ids requested
	join unit u on u.id = requested.id
	join book b on b.id = u.id
	where u.kind = 'book'
		and u.status = 'published'
		and u.visibility = 'public'
		and u.moderation_status = 'approved'
		and u.deleted_at is null
		and u.created_at <= $2::timestamptz
)
select jsonb_build_object(
	'id', s.id,
	'createdAt', s.created_at,
	'updatedAt', s.updated_at,
	'publishedAt', s.published_at,
	'status', s.status,
	'visibility', s.visibility,
	'moderationStatus', s.moderation_status,
	'contentRating', s.content_rating,
	'aiDisclosure', s.ai_disclosure,
	'details', jsonb_build_object(
		'releaseStatus', s.release_status,
		'isbn13', s.isbn13,
		'publicationDate', s.publication_date,
		'pageCount', s.page_count,
		'wordCount', s.word_count
	),
	'localizations', localizations.items,
	'aliases', aliases.items,
	'attributions', attributions.items
) as record
from selected s
cross join lateral (
	select jsonb_agg(
		jsonb_build_object(
			'language', l.language,
			'title', l.title,
			'summary', l.summary,
			'description', l.description,
			'position', l.position,
			'updatedAt', l.updated_at
		)
		order by l.position, l.language
	) as items
	from unit_localization l
	where l.unit_id = s.id
) localizations
cross join lateral (
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'id', a.id,
				'language', a.language,
				'term', a.term,
				'kind', a.kind
			)
			order by a.pinned desc, a.position nulls last, a.id
		),
		'[]'::jsonb
	) as items
	from unit_alias a
	where a.unit_id = s.id and a.withdrawn_at is null
) aliases
cross join lateral (
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'id', ca.id,
				'role', ca.role,
				'creditedUnitId', ca.credited_unit_id,
				'creditedUnitKind', credited.kind,
				'entityKind', e.kind,
				'entityVerified', e.verified,
				'localizations', coalesce(credited_localizations.items, '[]'::jsonb)
			)
			order by ca.position, ca.id
		),
		'[]'::jsonb
	) as items
	from credit_attribution ca
	join unit credited on credited.id = ca.credited_unit_id
	left join entity e on e.id = ca.credited_unit_id
	left join lateral (
		select jsonb_agg(
			jsonb_build_object(
				'language', cl.language,
				'title', cl.title,
				'summary', cl.summary
			)
			order by cl.position, cl.language
		) as items
		from unit_localization cl
		where cl.unit_id = ca.credited_unit_id
	) credited_localizations on true
	where ca.source_unit_id = s.id
) attributions
order by s.id;
