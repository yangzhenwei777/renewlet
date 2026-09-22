-- `_exclusive_` 文件名是部署维护门；预检、转换、复核和 guard 必须留在同一个 D1 migration 事务单元。
-- 排他迁移先用 CHECK 表扫描全部输入；任何损坏 JSON、重复顶层键或非对象 settings 都会中止整份 migration。
CREATE TABLE _renewlet_settings_locale_preference_preflight (
  user_id TEXT PRIMARY KEY,
  non_locale_settings_json TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO _renewlet_settings_locale_preference_preflight (user_id, non_locale_settings_json, valid)
SELECT
  user_id,
  CASE
    WHEN json_valid(settings_json) = 1 AND json_type(settings_json) IS 'object'
      THEN json_remove(settings_json, '$.locale', '$.localePreference')
    ELSE '{}'
  END,
  CASE
    WHEN json_valid(settings_json) = 0 THEN 0
    WHEN json_type(settings_json) IS NOT 'object' THEN 0
    WHEN EXISTS (SELECT 1 FROM json_each(settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 0
    ELSE 1
  END
FROM settings;

UPDATE settings
SET settings_json = json_set(
  json_remove(settings_json, '$.locale'),
  '$.localePreference',
  CASE
    WHEN json_type(settings_json, '$.localePreference') = 'text'
      AND json_extract(settings_json, '$.localePreference') IN ('auto', 'zh-CN', 'en-US')
      THEN json_extract(settings_json, '$.localePreference')
    WHEN json_type(settings_json, '$.locale') = 'text'
      AND json_extract(settings_json, '$.locale') IN ('zh-CN', 'en-US')
      THEN json_extract(settings_json, '$.locale')
    ELSE 'auto'
  END
);

CREATE TABLE _renewlet_settings_locale_preference_postflight (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

-- 非语言字段按 SQLite JSON 语义复核，防止未来修改转换语句时静默损坏整份账号设置。
INSERT INTO _renewlet_settings_locale_preference_postflight (valid)
SELECT CASE
  WHEN json_valid(settings.settings_json) = 0 THEN 0
  WHEN json_type(settings.settings_json) IS NOT 'object' THEN 0
  WHEN json_type(settings.settings_json, '$.locale') IS NOT NULL THEN 0
  WHEN json_type(settings.settings_json, '$.localePreference') IS NOT 'text' THEN 0
  WHEN json_extract(settings.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US') THEN 0
  WHEN json_remove(settings.settings_json, '$.locale', '$.localePreference')
    IS NOT _renewlet_settings_locale_preference_preflight.non_locale_settings_json THEN 0
  ELSE 1
END
FROM settings
JOIN _renewlet_settings_locale_preference_preflight USING (user_id);

DROP TABLE _renewlet_settings_locale_preference_postflight;
DROP TABLE _renewlet_settings_locale_preference_preflight;

CREATE TRIGGER renewlet_settings_locale_contract_insert
BEFORE INSERT ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;

CREATE TRIGGER renewlet_settings_locale_contract_update
BEFORE UPDATE OF settings_json ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;
