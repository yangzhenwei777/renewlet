-- 自定义 Logo 契约彻底切到私有资产路径或 http(s) 外链；旧 data URL/非持久 scheme 清空，HTTP 外链保留给自托管 HTTP 部署。
WITH logo_values AS (
  SELECT
    id,
    trim(logo) AS value,
    lower(trim(logo)) AS lower_value
  FROM subscriptions
  WHERE logo IS NOT NULL AND trim(logo) <> ''
),
http_values AS (
  SELECT
    id,
    value,
    lower_value,
    CASE
      WHEN lower_value LIKE 'http://%' THEN substr(value, length('http://') + 1)
      WHEN lower_value LIKE 'https://%' THEN substr(value, length('https://') + 1)
      ELSE NULL
    END AS rest_after_scheme
  FROM logo_values
),
classified AS (
  SELECT
    id,
    value,
    lower_value,
    CASE
      WHEN rest_after_scheme IS NULL THEN NULL
      ELSE substr(
        rest_after_scheme,
        1,
        min(
          instr(rest_after_scheme || '/', '/'),
          instr(rest_after_scheme || '?', '?'),
          instr(rest_after_scheme || '#', '#')
        ) - 1
      )
    END AS authority
  FROM http_values
)
UPDATE subscriptions
SET logo = NULL
WHERE id IN (
  SELECT id
  FROM classified
  WHERE
    lower_value LIKE 'data:%'
    OR length(value) > 2048
    OR lower_value LIKE 'blob:%'
    OR lower_value LIKE 'javascript:%'
    OR (
      value LIKE '/api/app/assets/%'
      AND (
        length(value) <= length('/api/app/assets/')
        OR substr(value, length('/api/app/assets/') + 1) LIKE '%/%'
        OR substr(value, length('/api/app/assets/') + 1) GLOB '*[^A-Za-z0-9_-]*'
      )
    )
    OR (
      value NOT LIKE '/api/app/assets/%'
      AND lower_value NOT LIKE 'http://%'
      AND lower_value NOT LIKE 'https://%'
    )
    OR (
      (lower_value LIKE 'http://%' OR lower_value LIKE 'https://%')
      AND (authority IS NULL OR authority = '' OR instr(authority, '@') > 0)
    )
);
