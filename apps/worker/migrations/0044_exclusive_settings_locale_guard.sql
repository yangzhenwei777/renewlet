-- 0043 已扩展俄语白名单；本迁移把 guard 替换纳入排他部署与完整定义复核，不改写历史迁移或账号设置。
CREATE TABLE _renewlet_settings_locale_guard_preflight (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO _renewlet_settings_locale_guard_preflight (valid)
SELECT CASE
  WHEN json_valid(settings_json) = 0 THEN 0
  WHEN json_type(settings_json) IS NOT 'object' THEN 0
  WHEN EXISTS (SELECT 1 FROM json_each(settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 0
  WHEN json_type(settings_json, '$.locale') IS NOT NULL THEN 0
  WHEN json_type(settings_json, '$.localePreference') IS NOT 'text' THEN 0
  WHEN json_extract(settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 0
  ELSE 1
END FROM settings;

DROP TABLE _renewlet_settings_locale_guard_preflight;
DROP TRIGGER IF EXISTS renewlet_settings_locale_contract_insert;
DROP TRIGGER IF EXISTS renewlet_settings_locale_contract_update;

CREATE TRIGGER renewlet_settings_locale_contract_insert
BEFORE INSERT ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 1
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
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;
