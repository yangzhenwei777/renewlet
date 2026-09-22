package main

// notification_email_template.go 渲染邮件渠道的 HTML 正文。
//
// 架构位置：HTML 放在 embedded .gohtml 模板，文案来自服务端统一 catalog，
// Go 只负责准备 view model。这样既能保持严格邮件客户端兼容，也避免邮件渠道维护第二套文案源。
//
// 注意： 不要把预渲染 HTML 传进模板；用户可控值必须继续交给 html/template 做上下文转义。
import (
	"bytes"
	"embed"
	"fmt"
	"html/template"
	"math"
	"net/url"
	"os"
	"strings"
	"sync"
)

const (
	// 邮件正文必须有硬上限，避免异常订阅备注或通知内容让 SMTP 请求膨胀。
	emailMaxHTMLBytes     = 100 * 1024
	emailCompactTextRunes = 12000
)

// 邮件布局独立 embed；文案来自服务端统一 catalog，避免邮件渠道成为第三套 i18n 事实源。
//
//go:embed templates/email/*.gohtml
var emailTemplateFS embed.FS

var (
	emailTemplateOnce sync.Once
	emailTemplateSet  *template.Template
	emailTemplateErr  error
)

type emailTheme struct {
	Primary      string
	PrimaryText  string
	PrimarySoft  string
	Background   string
	Surface      string
	SurfaceMuted string
	Border       string
	Text         string
	Muted        string
}

type emailBrand struct {
	Name       string
	HeaderMark emailBrandMark
}

type emailBrandMark struct {
	ClassName    string
	Size         int
	Radius       int
	Background   string
	Border       string
	Foreground   string
	Accent       string
	TopWidth     int
	TopHeight    int
	TopRadius    int
	DotSize      int
	DotRadius    int
	Gap          int
	RowGap       int
	BottomWidth  int
	BottomHeight int
	BottomRadius int
	BottomInset  int
}

type emailCatalog struct {
	BrandTagline          string `json:"brandTagline"`
	Generated             string `json:"generated"`
	NoReminders           string `json:"noReminders"`
	TestNotification      string `json:"testNotification"`
	ReminderItems         string `json:"reminderItems"`
	Message               string `json:"message"`
	EmptyDetails          string `json:"emptyDetails"`
	GeneratedAt           string `json:"generatedAt"`
	Footer                string `json:"footer"`
	Truncated             string `json:"truncated"`
	UpcomingRenewals      string `json:"upcomingRenewals"`
	UpcomingExpiries      string `json:"upcomingExpiries"`
	TrialEnding           string `json:"trialEnding"`
	Expired               string `json:"expired"`
	CollectionReminders   string `json:"collectionReminders"`
	BillingDate           string `json:"billingDate"`
	ExpiryDate            string `json:"expiryDate"`
	TrialEnds             string `json:"trialEnds"`
	ExpiredSince          string `json:"expiredSince"`
	CollectionDate        string `json:"collectionDate"`
	UpdateNextBillingDate string `json:"updateNextBillingDate"`
	CollectFrom           string `json:"collectFrom"`
	DayBefore             string `json:"dayBefore"`
	DaysBefore            string `json:"daysBefore"`
	RepeatEvery           string `json:"repeatEvery"`
	PreheaderItems        string `json:"preheaderItems"`
	CTAViewSubscriptions  string `json:"ctaViewSubscriptions"`
	CTAOpenSettings       string `json:"ctaOpenSettings"`
}

type emailTemplateData struct {
	LayoutMode            string
	Lang                  string
	Title                 string
	Preheader             string
	StatusLabel           string
	Summary               emailTemplateSummaryPanel
	MessagePanel          *emailTemplateMessagePanel
	Groups                []emailTemplateGroup
	ShowCTA               bool
	ShowCardBottomPadding bool
	CTAURL                string
	CTALabel              string
	Timestamp             string
	Copy                  emailCatalog
	Theme                 emailTheme
	Brand                 emailBrand
}

type emailLayoutMode string

const (
	emailLayoutReminderList   emailLayoutMode = "reminder-list"
	emailLayoutTestStatus     emailLayoutMode = "test-status"
	emailLayoutEmptyMessage   emailLayoutMode = "empty-message"
	emailLayoutCompactMessage emailLayoutMode = "compact-message"
)

type emailTemplateSummaryPanel struct {
	Eyebrow string
	Value   string
	Label   string
	Detail  string
	Rows    []emailTemplateSummaryRow
}

type emailTemplateSummaryRow struct {
	Label string
	Value string
}

type emailTemplateMessagePanel struct {
	Label string
	Lines []string
}

type emailTemplateGroup struct {
	Label string
	Count int
	Items []emailTemplateItem
}

type emailTemplateItem struct {
	Name       string
	DateLabel  string
	TargetDate string
	Amount     string
	Currency   string
	Detail     string
}

func buildEmailHTMLMessage(settings appSettings, message notificationMessage, locale appLocale) (string, error) {
	data, err := buildEmailTemplateData(settings, message, locale, false)
	if err != nil {
		return "", err
	}
	body, err := renderEmailTemplate(data)
	if err != nil {
		return "", err
	}
	if len(body) <= emailMaxHTMLBytes {
		return body, nil
	}

	// 超限时降级为紧凑正文而不是直接失败，避免大量提醒项导致邮件渠道整批不可用。
	compactData, err := buildEmailTemplateData(settings, message, locale, true)
	if err != nil {
		return "", err
	}
	return renderEmailTemplate(compactData)
}

func buildEmailTemplateData(settings appSettings, message notificationMessage, locale appLocale, compact bool) (emailTemplateData, error) {
	copy := loadEmailCatalog(locale)
	itemCount := len(message.Items)
	hasReminderItems := itemCount > 0
	layoutMode := emailLayoutModeForMessage(message, compact)
	if compact {
		message.Items = nil
		message.Content = emailCompactContent(message.Content, copy)
	}

	groups := []emailTemplateGroup{}
	if len(message.Items) > 0 {
		groups = buildEmailTemplateGroups(message.Items, locale, copy)
	}
	statusLabel := emailStatusLabel(itemCount, message.HasPayload, copy)

	var messagePanel *emailTemplateMessagePanel
	if layoutMode == emailLayoutEmptyMessage || layoutMode == emailLayoutCompactMessage {
		messagePanel = &emailTemplateMessagePanel{
			Label: copy.Message,
			Lines: splitEmailContentLines(message.Content, copy),
		}
	}
	showCTA, ctaURL, ctaLabel := emailCTAFromAppURL(os.Getenv("APP_URL"), hasReminderItems, copy)

	return emailTemplateData{
		LayoutMode:            string(layoutMode),
		Lang:                  emailHTMLLang(locale),
		Title:                 message.Title,
		Preheader:             emailPreheader(message, copy),
		StatusLabel:           statusLabel,
		Summary:               emailSummaryPanel(itemCount, groups, statusLabel, message, copy),
		MessagePanel:          messagePanel,
		Groups:                groups,
		ShowCTA:               showCTA,
		ShowCardBottomPadding: !showCTA,
		CTAURL:                ctaURL,
		CTALabel:              ctaLabel,
		Timestamp:             message.Timestamp,
		Copy:                  copy,
		Theme:                 emailThemeFromSettings(settings),
		Brand:                 emailBrandView(),
	}, nil
}

func emailLayoutModeForMessage(message notificationMessage, compact bool) emailLayoutMode {
	if compact {
		return emailLayoutCompactMessage
	}
	if len(message.Items) > 0 {
		return emailLayoutReminderList
	}
	if message.HasPayload {
		return emailLayoutTestStatus
	}
	return emailLayoutEmptyMessage
}

func renderEmailTemplate(data emailTemplateData) (string, error) {
	templates, err := emailTemplates()
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	if err := templates.ExecuteTemplate(&out, "notification.gohtml", data); err != nil {
		return "", err
	}
	return out.String(), nil
}

func emailTemplates() (*template.Template, error) {
	emailTemplateOnce.Do(func() {
		emailTemplateSet, emailTemplateErr = template.ParseFS(emailTemplateFS, "templates/email/*.gohtml")
	})
	return emailTemplateSet, emailTemplateErr
}

func loadEmailCatalog(locale appLocale) emailCatalog {
	return emailCatalog{
		BrandTagline:          serverText(locale, "email.brandTagline"),
		Generated:             serverText(locale, "email.generated"),
		NoReminders:           serverText(locale, "email.noReminders"),
		TestNotification:      serverText(locale, "email.testNotification"),
		ReminderItems:         serverText(locale, "email.reminderItems"),
		Message:               serverText(locale, "email.message"),
		EmptyDetails:          serverText(locale, "email.emptyDetails"),
		GeneratedAt:           serverText(locale, "email.generatedAt"),
		Footer:                serverText(locale, "email.footer"),
		Truncated:             serverText(locale, "email.truncated"),
		UpcomingRenewals:      serverText(locale, "email.upcomingRenewals"),
		UpcomingExpiries:      serverText(locale, "email.upcomingExpiries"),
		TrialEnding:           serverText(locale, "email.trialEnding"),
		Expired:               serverText(locale, "email.expired"),
		CollectionReminders:   serverText(locale, "email.collectionReminders"),
		BillingDate:           serverText(locale, "email.billingDate"),
		ExpiryDate:            serverText(locale, "email.expiryDate"),
		TrialEnds:             serverText(locale, "email.trialEnds"),
		ExpiredSince:          serverText(locale, "email.expiredSince"),
		CollectionDate:        serverText(locale, "email.collectionDate"),
		UpdateNextBillingDate: serverText(locale, "email.updateNextBillingDate"),
		CollectFrom:           serverText(locale, "email.collectFrom"),
		DayBefore:             serverText(locale, "email.dayBefore"),
		DaysBefore:            serverText(locale, "email.daysBefore"),
		RepeatEvery:           serverText(locale, "email.repeatEvery"),
		PreheaderItems:        serverText(locale, "email.preheaderItems"),
		CTAViewSubscriptions:  serverText(locale, "email.ctaViewSubscriptions"),
		CTAOpenSettings:       serverText(locale, "email.ctaOpenSettings"),
	}
}

func buildEmailTemplateGroups(items []notificationContentItem, locale appLocale, copy emailCatalog) []emailTemplateGroup {
	grouped := map[string][]notificationContentItem{
		"renewal":     {},
		"expiry":      {},
		"trial":       {},
		"expired":     {},
		"costSharing": {},
	}
	for _, item := range items {
		itemType := item.Type
		if _, ok := grouped[itemType]; !ok {
			// 未知类型按续费处理，保证历史旧数据仍能渲染，而不是让整封邮件失败。
			itemType = "renewal"
		}
		grouped[itemType] = append(grouped[itemType], item)
	}

	// subscription logoUrl 不进入邮件模板；外链图片会让邮件客户端暴露私有资产或第三方请求痕迹。
	// 邮件分组顺序固定，避免 map iteration 导致同一批提醒在不同运行中顺序抖动。
	order := []string{"renewal", "expiry", "trial", "expired", "costSharing"}
	groups := make([]emailTemplateGroup, 0, len(order))
	for _, itemType := range order {
		rawItems := grouped[itemType]
		if len(rawItems) == 0 {
			continue
		}
		group := emailTemplateGroup{
			Label: emailGroupLabel(itemType, copy),
			Count: len(rawItems),
			Items: make([]emailTemplateItem, 0, len(rawItems)),
		}
		for _, item := range rawItems {
			group.Items = append(group.Items, emailTemplateItem{
				Name:       item.Name,
				DateLabel:  emailItemDateLabel(item.Type, copy),
				TargetDate: item.TargetDate,
				Amount:     formatAmount(emailItemAmount(item)),
				Currency:   emailItemCurrency(item),
				Detail:     emailItemDetail(item, locale, copy),
			})
		}
		groups = append(groups, group)
	}
	return groups
}

func emailStatusLabel(itemCount int, hasPayload bool, copy emailCatalog) string {
	if itemCount == 0 && !hasPayload {
		return copy.NoReminders
	}
	if itemCount == 0 {
		return copy.TestNotification
	}
	return copy.Generated
}

func emailSummaryPanel(itemCount int, groups []emailTemplateGroup, statusLabel string, message notificationMessage, copy emailCatalog) emailTemplateSummaryPanel {
	hasReminderItems := itemCount > 0
	detail := firstNonEmptyLine(message.Content)
	if hasReminderItems {
		detail = formatCatalogCopy(copy.PreheaderItems, map[string]interface{}{"count": itemCount})
	} else if detail == "" {
		detail = message.Title
	}
	label := statusLabel
	if hasReminderItems {
		label = copy.ReminderItems
	}
	return emailTemplateSummaryPanel{
		Eyebrow: statusLabel,
		Value:   fmt.Sprint(itemCount),
		Label:   label,
		Detail:  detail,
		Rows:    emailSummaryRows(itemCount, groups, copy),
	}
}

func emailSummaryRows(itemCount int, groups []emailTemplateGroup, copy emailCatalog) []emailTemplateSummaryRow {
	if len(groups) == 0 {
		if itemCount == 0 {
			return nil
		}
		return []emailTemplateSummaryRow{{
			Label: copy.ReminderItems,
			Value: fmt.Sprint(itemCount),
		}}
	}
	rows := make([]emailTemplateSummaryRow, 0, len(groups))
	for _, group := range groups {
		rows = append(rows, emailTemplateSummaryRow{
			Label: group.Label,
			Value: fmt.Sprint(group.Count),
		})
	}
	return rows
}

func emailCTAFromAppURL(rawAppURL string, hasReminderItems bool, copy emailCatalog) (bool, string, string) {
	appURL := strings.TrimSpace(rawAppURL)
	if appURL == "" {
		return false, "", ""
	}
	parsed, err := url.Parse(appURL)
	if err != nil {
		return false, "", ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if parsed.Host == "" || (scheme != "http" && scheme != "https") {
		return false, "", ""
	}

	targetPath := "/settings"
	label := copy.CTAOpenSettings
	if hasReminderItems {
		targetPath = "/subscriptions"
		label = copy.CTAViewSubscriptions
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	if basePath == "" {
		parsed.Path = targetPath
	} else {
		// 支持应用挂在子路径下的反代部署，例如 https://example.com/renewlet。
		parsed.Path = basePath + targetPath
	}
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return true, parsed.String(), label
}

func emailThemeFromSettings(settings appSettings) emailTheme {
	h, s, l := emailThemeHSL(settings)
	primary := hslToHex(h, s, l)
	return emailTheme{
		Primary:      primary,
		PrimaryText:  contrastTextForHSL(h, s, l),
		PrimarySoft:  hslToHex(h, math.Min(s, 50), 95),
		Background:   "#F5F7F6",
		Surface:      "#FFFFFF",
		SurfaceMuted: "#F8FAF9",
		Border:       "#E6EAE8",
		Text:         "#0F172A",
		Muted:        "#64748B",
	}
}

// 邮件品牌标识只提供内联 primitives 的尺寸和颜色；不要改成 SVG/IMG/CID，避免邮件客户端拦截或远程请求泄露。
func emailBrandView() emailBrand {
	base := emailBrandMark{
		Background: "#111720",
		Border:     "#26313D",
		Foreground: "#F8FAFC",
		Accent:     "#10B981",
	}
	header := base
	header.ClassName = "email-brand-lockup-mark"
	header.Size = 28
	header.Radius = 7
	header.TopWidth = 13
	header.TopHeight = 4
	header.TopRadius = 2
	header.DotSize = 4
	header.DotRadius = 2
	header.Gap = 3
	header.RowGap = 6
	header.BottomWidth = 15
	header.BottomHeight = 3
	header.BottomRadius = 2
	header.BottomInset = 2

	return emailBrand{
		Name:       "Renewlet",
		HeaderMark: header,
	}
}

func emailThemeHSL(settings appSettings) (float64, float64, float64) {
	switch strings.TrimSpace(settings.ThemeVariant) {
	case "ocean":
		return 210, 90, 45
	case "sunset":
		return 25, 95, 48
	case "lavender":
		return 270, 70, 55
	case "rose":
		return 340, 75, 50
	case "custom":
		if validEmailCustomColor(settings.ThemeCustomColor) {
			return settings.ThemeCustomColor.H, settings.ThemeCustomColor.S, settings.ThemeCustomColor.L
		}
	}
	return 160, 84, 39
}

func validEmailCustomColor(color themeCustomColor) bool {
	values := []float64{color.H, color.S, color.L}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return color.H >= 0 && color.H <= 360 && color.S >= 0 && color.S <= 100 && color.L >= 0 && color.L <= 100
}

func emailHTMLLang(locale appLocale) string {
	// HTML lang 直接跟随服务端 catalog 的 BCP 47 tag；新增语言不应再改邮件模板代码。
	return string(locale)
}

func emailPreheader(message notificationMessage, copy emailCatalog) string {
	if len(message.Items) > 0 {
		return formatCatalogCopy(copy.PreheaderItems, map[string]interface{}{"count": len(message.Items)})
	}
	content := firstNonEmptyLine(message.Content)
	if content != "" {
		return content
	}
	return message.Title
}

func firstNonEmptyLine(input string) string {
	for _, line := range strings.Split(strings.ReplaceAll(input, "\r\n", "\n"), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func emailGroupLabel(itemType string, copy emailCatalog) string {
	switch itemType {
	case "costSharing":
		return copy.CollectionReminders
	case "expiry":
		return copy.UpcomingExpiries
	case "trial":
		return copy.TrialEnding
	case "expired":
		return copy.Expired
	default:
		return copy.UpcomingRenewals
	}
}

func emailItemDateLabel(itemType string, copy emailCatalog) string {
	switch itemType {
	case "costSharing":
		return copy.CollectionDate
	case "expiry":
		return copy.ExpiryDate
	case "trial":
		return copy.TrialEnds
	case "expired":
		return copy.ExpiredSince
	default:
		return copy.BillingDate
	}
}

func emailItemDetail(item notificationContentItem, _ appLocale, copy emailCatalog) string {
	if item.Type == "costSharing" && item.CostSharing != nil {
		return formatCatalogCopy(copy.CollectFrom, map[string]interface{}{"member": item.CostSharing.MemberName, "days": item.ReminderDays})
	}
	if item.Type == "expired" {
		return copy.UpdateNextBillingDate
	}
	if item.RepeatReminder != nil && copy.RepeatEvery != "" {
		return formatCatalogCopy(copy.RepeatEvery, map[string]interface{}{"hours": repeatReminderIntervalHours(item.RepeatReminder.Interval)})
	}
	if item.ReminderDays == 1 && copy.DayBefore != "" {
		return formatCatalogCopy(copy.DayBefore, map[string]interface{}{"days": item.ReminderDays})
	}
	return formatCatalogCopy(copy.DaysBefore, map[string]interface{}{"days": item.ReminderDays})
}

func emailItemAmount(item notificationContentItem) string {
	if item.Type == "costSharing" && item.CostSharing != nil {
		return item.CostSharing.Amount
	}
	return item.Price
}

func emailItemCurrency(item notificationContentItem) string {
	if item.Type == "costSharing" && item.CostSharing != nil {
		return item.CostSharing.Currency
	}
	return item.Currency
}

func formatCatalogCopy(message string, params map[string]interface{}) string {
	return serverFormatMessage(message, params)
}

func splitEmailContentLines(input string, copy emailCatalog) []string {
	normalized := strings.ReplaceAll(input, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := []string{}
	for _, line := range strings.Split(strings.TrimSpace(normalized), "\n") {
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return []string{copy.EmptyDetails}
	}
	return lines
}

func emailCompactContent(input string, copy emailCatalog) string {
	runes := []rune(input)
	if len(runes) <= emailCompactTextRunes {
		return input
	}
	return strings.TrimSpace(string(runes[:emailCompactTextRunes])) + "\n\n" + copy.Truncated
}

func hslToHex(h, s, l float64) string {
	h = math.Mod(h, 360)
	if h < 0 {
		h += 360
	}
	s = clamp01(s / 100)
	l = clamp01(l / 100)
	c := (1 - math.Abs(2*l-1)) * s
	x := c * (1 - math.Abs(math.Mod(h/60, 2)-1))
	m := l - c/2

	// 这里手写 HSL->RGB 是为了邮件模板不依赖浏览器 CSS 颜色函数，老邮件客户端也能渲染 hex。
	r, g, b := 0.0, 0.0, 0.0
	switch {
	case h < 60:
		r, g, b = c, x, 0
	case h < 120:
		r, g, b = x, c, 0
	case h < 180:
		r, g, b = 0, c, x
	case h < 240:
		r, g, b = 0, x, c
	case h < 300:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}
	return fmt.Sprintf("#%02X%02X%02X", byte(math.Round((r+m)*255)), byte(math.Round((g+m)*255)), byte(math.Round((b+m)*255)))
}

func contrastTextForHSL(h, s, l float64) string {
	r, g, b := hslToRGB(h, s, l)
	luminance := relativeLuminance(r, g, b)
	// 使用相对亮度选择黑/白文字，保证自定义主题色在邮件 CTA 上仍有基本可读性。
	if luminance > 0.52 {
		return "#111827"
	}
	return "#FFFFFF"
}

func hslToRGB(h, s, l float64) (float64, float64, float64) {
	h = math.Mod(h, 360)
	if h < 0 {
		h += 360
	}
	s = clamp01(s / 100)
	l = clamp01(l / 100)
	c := (1 - math.Abs(2*l-1)) * s
	x := c * (1 - math.Abs(math.Mod(h/60, 2)-1))
	m := l - c/2
	r, g, b := 0.0, 0.0, 0.0
	switch {
	case h < 60:
		r, g, b = c, x, 0
	case h < 120:
		r, g, b = x, c, 0
	case h < 180:
		r, g, b = 0, c, x
	case h < 240:
		r, g, b = 0, x, c
	case h < 300:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}
	return r + m, g + m, b + m
}

func relativeLuminance(r, g, b float64) float64 {
	return 0.2126*linearizedRGB(r) + 0.7152*linearizedRGB(g) + 0.0722*linearizedRGB(b)
}

func linearizedRGB(value float64) float64 {
	if value <= 0.03928 {
		return value / 12.92
	}
	return math.Pow((value+0.055)/1.055, 2.4)
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}
