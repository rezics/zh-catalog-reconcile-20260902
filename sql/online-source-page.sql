select
	u.id,
	source_zh.title
from unit u
join book b on b.id = u.id
join unit_localization source_zh
	on source_zh.unit_id = u.id and source_zh.language = 'zh'
where u.kind = 'book'
	and u.status = 'published'
	and u.visibility = 'public'
	and u.moderation_status = 'approved'
	and u.deleted_at is null
	and u.created_at <= $1::timestamptz
	and (u.created_at, u.id) > (
		coalesce($2::timestamptz, '-infinity'::timestamptz),
		coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
	)
	and not exists (
		select 1
		from unit_localization source_other
		where source_other.unit_id = u.id
			and source_other.language <> 'zh'
	)
order by u.created_at, u.id
limit $4::integer;
