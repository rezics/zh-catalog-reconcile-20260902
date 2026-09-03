with source_input as materialized (
	select
		input."sourceUnitId"::uuid as source_unit_id,
		coalesce(nullif(btrim(input.title), ''), input."sourceUnitId") as search_title
	from jsonb_to_recordset($1::jsonb) as input("sourceUnitId" text, title text)
)
select
	source_input.source_unit_id as "sourceUnitId",
	search_candidate.unit_id as "candidateUnitId",
	search_candidate.position::integer as "position"
from source_input
cross join lateral public.search_text_candidates(
	array[left(source_input.search_title, 512)]::text[],
	array['zh']::text[],
	'book',
	null::bigint,
	null::uuid,
	50000,
	$2::integer
) with ordinality as search_candidate(
	unit_id,
	unit_updated_at_micros,
	search_matched,
	position
)
join unit candidate on candidate.id = search_candidate.unit_id
join book candidate_book on candidate_book.id = candidate.id
where search_candidate.search_matched
	and candidate.kind = 'book'
	and candidate.status = 'published'
	and candidate.visibility = 'public'
	and candidate.moderation_status = 'approved'
	and candidate.deleted_at is null
	and candidate.created_at <= $3::timestamptz
order by source_input.source_unit_id, search_candidate.position;
