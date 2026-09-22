package main

import (
	"strings"
	"time"
)

const demoModeLogoProvider = "thesvg"

type demoSubscriptionSeedSource struct {
	Slug               string
	Name               string
	LogoSlug           string
	LogoURL            string
	Price              string
	Currency           string
	BillingCycle       string
	Category           string
	Status             string
	PaymentMethod      string
	StartOffsetDays    int
	NextOffsetDays     int
	TrialEndOffsetDays *int
	ReminderDays       int
	Website            string
	PricingSource      string
	Tags               []string
	PlanLabel          string
	PriceBasis         string
}

type demoSubscriptionSeed struct {
	Order                        int
	Slug                         string
	LogoSlug                     string
	LogoURL                      string
	Name                         string
	Price                        string
	Currency                     string
	BillingCycle                 string
	CustomDays                   int
	CustomCycleUnit              string
	OneTimeTermCount             int
	OneTimeTermUnit              string
	Category                     string
	Status                       string
	Pinned                       bool
	PublicHidden                 bool
	PaymentMethod                string
	StartDate                    string
	NextBillingDate              string
	AutoRenew                    bool
	AutoCalculateNextBillingDate bool
	TrialEndDate                 string
	Website                      string
	PricingSource                string
	PlanLabel                    string
	PriceBasis                   string
	Notes                        string
	Tags                         []string
	ReminderDays                 int
	RepeatReminderEnabled        bool
	RepeatReminderInterval       string
	RepeatReminderWindow         string
}

var demoPinnedSubscriptionSlugs = map[string]struct{}{
	"chatgpt-plus":                {},
	"github-copilot-pro":          {},
	"cursor-pro":                  {},
	"vercel-pro":                  {},
	"supabase-pro":                {},
	"cloudflare-workers-paid":     {},
	"testrail-professional-cloud": {},
	"linear-business":             {},
}

func demoSubscriptionSeedSourceItem(slug string, name string, logoSlug string, logoURL string, price string, currency string, billingCycle string, category string, status string, paymentMethod string, startOffsetDays int, nextOffsetDays int, trialEndOffsetDays *int, reminderDays int, website string, pricingSource string, tags []string, planLabel string, priceBasis string) demoSubscriptionSeedSource {
	return demoSubscriptionSeedSource{
		Slug:               slug,
		Name:               name,
		LogoSlug:           logoSlug,
		LogoURL:            logoURL,
		Price:              mustDemoMoneyString(price),
		Currency:           currency,
		BillingCycle:       billingCycle,
		Category:           category,
		Status:             status,
		PaymentMethod:      paymentMethod,
		StartOffsetDays:    startOffsetDays,
		NextOffsetDays:     nextOffsetDays,
		TrialEndOffsetDays: trialEndOffsetDays,
		ReminderDays:       reminderDays,
		Website:            website,
		PricingSource:      pricingSource,
		Tags:               tags,
		PlanLabel:          planLabel,
		PriceBasis:         priceBasis,
	}
}

func mustDemoMoneyString(value string) string {
	amount, err := canonicalMoneyString(value)
	if err != nil {
		// demo catalog 随源码发布，不是用户输入；金额 seed 损坏要在启动/测试时失败，不能静默写成 0。
		panic("invalid demo money seed: " + value)
	}
	return amount
}

func demoIntPtr(value int) *int {
	return &value
}

// catalog 由 harness 开发者订阅事实源生成；Go 只在 reset 时派生相对日期，防止价格快照和动态账期混在一起维护。
func demoSubscriptionSeeds(now time.Time) []demoSubscriptionSeed {
	seeds := make([]demoSubscriptionSeed, 0, len(demoSubscriptionSeedCatalog))
	for index, source := range demoSubscriptionSeedCatalog {
		seeds = append(seeds, source.toDemoSubscriptionSeed(now, index+1))
	}
	return seeds
}

func (source demoSubscriptionSeedSource) toDemoSubscriptionSeed(now time.Time, order int) demoSubscriptionSeed {
	trialEndDate := ""
	if source.TrialEndOffsetDays != nil {
		trialEndDate = demoDate(now, *source.TrialEndOffsetDays)
	}
	_, pinned := demoPinnedSubscriptionSlugs[source.Slug]
	return demoSubscriptionSeed{
		Order:                        order,
		Slug:                         source.Slug,
		LogoSlug:                     source.LogoSlug,
		LogoURL:                      source.LogoURL,
		Name:                         source.Name,
		Price:                        source.Price,
		Currency:                     source.Currency,
		BillingCycle:                 source.BillingCycle,
		Category:                     source.Category,
		Status:                       source.Status,
		Pinned:                       pinned,
		PaymentMethod:                source.PaymentMethod,
		StartDate:                    demoDate(now, source.StartOffsetDays),
		NextBillingDate:              demoDate(now, source.NextOffsetDays),
		AutoRenew:                    false,
		AutoCalculateNextBillingDate: false,
		TrialEndDate:                 trialEndDate,
		Website:                      source.Website,
		PricingSource:                source.PricingSource,
		PlanLabel:                    source.PlanLabel,
		PriceBasis:                   source.PriceBasis,
		Notes:                        demoPricingNote(source.Name, source.PlanLabel, source.PriceBasis),
		Tags:                         append([]string(nil), source.Tags...),
		ReminderDays:                 source.ReminderDays,
		RepeatReminderEnabled:        false,
		RepeatReminderInterval:       defaultRepeatReminderInterval,
		RepeatReminderWindow:         defaultRepeatReminderWindow,
	}
}

func (seed demoSubscriptionSeed) logoURL() string {
	if logoURL := strings.TrimSpace(seed.LogoURL); logoURL != "" {
		return logoURL
	}
	return demoTheSVGLogo(seed.LogoSlug)
}

func demoTheSVGLogo(slug string) string {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return ""
	}
	// demo seed 复用内置 Logo resolver 的 provider base，避免公开演示数据再次漂到失效 CDN 路径。
	return strings.TrimRight(mediaResolverBuiltInProviderBase(demoModeLogoProvider), "/") + "/public/icons/" + slug + "/default.svg"
}

func demoPricingNote(name string, planLabel string, priceBasis string) string {
	return name + " (" + planLabel + ") uses the official public price basis: " + priceBasis + ". Checked " + demoModePriceCheckedAt + ". Demo data only; official pricing may change by region, tax, billing term, usage, seat count, and plan update."
}

func demoDate(now time.Time, offsetDays int) string {
	loc, err := time.LoadLocation(demoModeScheduleTimezone)
	if err != nil {
		loc = time.UTC
	}
	// date-only 字段按演示时区做日历日偏移，避免 UTC 午夜附近 reset 时把续费日推到相邻日期。
	return now.In(loc).AddDate(0, 0, offsetDays).Format("2006-01-02")
}
