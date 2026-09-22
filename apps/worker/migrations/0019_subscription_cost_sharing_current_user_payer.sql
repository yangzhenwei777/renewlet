-- 当前用户固定是付款人；旧 self 成员行必须删除，否则会被误读成“其他成员应收金额”。
UPDATE subscriptions
SET cost_sharing_json = '{}'
WHERE json_valid(cost_sharing_json)
  AND json_type(cost_sharing_json, '$.selfMemberId') = 'text'
  AND json_type(cost_sharing_json, '$.members') = 'array'
  AND (
    SELECT COUNT(*)
    FROM json_each(json_extract(cost_sharing_json, '$.members'))
    WHERE json_extract(value, '$.id') != json_extract(cost_sharing_json, '$.selfMemberId')
  ) = 0;

UPDATE subscriptions
SET cost_sharing_json = json_set(
  cost_sharing_json,
  '$.members',
  (
    SELECT json_group_array(json(json_remove(value, '$.included')))
    FROM json_each(json_extract(cost_sharing_json, '$.members'))
    WHERE json_extract(value, '$.id') != json_extract(cost_sharing_json, '$.selfMemberId')
  )
)
WHERE json_valid(cost_sharing_json)
  AND json_type(cost_sharing_json, '$.selfMemberId') = 'text'
  AND json_type(cost_sharing_json, '$.members') = 'array';

UPDATE subscriptions
SET cost_sharing_json = json_set(
  cost_sharing_json,
  '$.members',
  (
    SELECT json_group_array(json(json_remove(value, '$.included')))
    FROM json_each(json_extract(cost_sharing_json, '$.members'))
  )
)
WHERE json_valid(cost_sharing_json)
  AND json_type(cost_sharing_json, '$.members') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(cost_sharing_json, '$.members'))
    WHERE json_type(value, '$.included') IS NOT NULL
  );

UPDATE subscriptions
SET cost_sharing_json = json_remove(cost_sharing_json, '$.payerMemberId', '$.selfMemberId')
WHERE json_valid(cost_sharing_json)
  AND (
    json_type(cost_sharing_json, '$.payerMemberId') IS NOT NULL
    OR json_type(cost_sharing_json, '$.selfMemberId') IS NOT NULL
  );
