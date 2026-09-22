-- 月度汇率快照是报表折算口径，不是付款流水或法定外汇报价；历史缺口不能用当前汇率伪造。
CREATE TABLE IF NOT EXISTS exchange_rate_snapshots (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (
    month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  base TEXT NOT NULL DEFAULT 'USD' CHECK (base = 'USD'),
  rates_json TEXT NOT NULL CHECK (json_valid(rates_json)),
  requested_provider TEXT NOT NULL CHECK (requested_provider IN ('frankfurter', 'floatrates', 'exchange-api')),
  provider TEXT NOT NULL CHECK (provider IN ('frankfurter', 'floatrates', 'exchange-api')),
  source_date TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  warning_json TEXT CHECK (warning_json IS NULL OR json_valid(warning_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);
