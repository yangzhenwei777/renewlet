package main

type customConfigLabels struct {
	ZhCN string `json:"zh-CN"`
	EnUS string `json:"en-US"`
}

type customConfigItem struct {
	ID      string             `json:"id"`
	Value   string             `json:"value"`
	Labels  customConfigLabels `json:"labels"`
	Color   string             `json:"color,omitempty"`
	Icon    string             `json:"icon,omitempty"`
	Enabled *bool              `json:"enabled,omitempty"`
}

type customConfigPayload struct {
	Categories     []customConfigItem `json:"categories"`
	Statuses       []customConfigItem `json:"statuses"`
	PaymentMethods []customConfigItem `json:"paymentMethods"`
	Currencies     []customConfigItem `json:"currencies"`
}
