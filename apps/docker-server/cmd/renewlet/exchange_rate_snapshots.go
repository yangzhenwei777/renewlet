package main

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const maxExchangeRateSnapshotsPerUser = 240

var exchangeRateSnapshotMonthRe = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

type exchangeRateCoverageWarningDTO struct {
	Kind              string            `json:"kind"`
	Provider          string            `json:"provider"`
	MissingCurrencies []string          `json:"missingCurrencies"`
	FillSources       map[string]string `json:"fillSources"`
}

type exchangeRateSnapshotBody struct {
	Base              string                          `json:"base"`
	Rates             map[string]float64              `json:"rates"`
	RequestedProvider string                          `json:"requestedProvider"`
	Provider          string                          `json:"provider"`
	SourceDate        string                          `json:"sourceDate"`
	Warning           *exchangeRateCoverageWarningDTO `json:"warning,omitempty"`
}

type exchangeRateSnapshotDTO struct {
	SchemaVersion     int                             `json:"schemaVersion"`
	Month             string                          `json:"month"`
	Base              string                          `json:"base"`
	Rates             map[string]float64              `json:"rates"`
	RequestedProvider string                          `json:"requestedProvider"`
	Provider          string                          `json:"provider"`
	SourceDate        string                          `json:"sourceDate"`
	CapturedAt        string                          `json:"capturedAt"`
	Warning           *exchangeRateCoverageWarningDTO `json:"warning,omitempty"`
}

type exchangeRateSnapshotsResponse struct {
	Snapshots []exchangeRateSnapshotDTO `json:"snapshots"`
}

type exchangeRateSnapshotResponse struct {
	Snapshot exchangeRateSnapshotDTO `json:"snapshot"`
}

type exchangeRatePublicBasis struct {
	Status     string             `json:"status"`
	Month      string             `json:"month"`
	Base       string             `json:"base,omitempty"`
	Rates      map[string]float64 `json:"rates,omitempty"`
	SourceDate string             `json:"sourceDate,omitempty"`
	CapturedAt string             `json:"capturedAt,omitempty"`
}

func (body *exchangeRateSnapshotBody) Validate(_ appLocale) error {
	return normalizeExchangeRateSnapshotBody(body)
}

func normalizeExchangeRateSnapshotBody(body *exchangeRateSnapshotBody) error {
	body.Base = strings.ToUpper(strings.TrimSpace(body.Base))
	body.RequestedProvider = strings.TrimSpace(body.RequestedProvider)
	body.Provider = strings.TrimSpace(body.Provider)
	body.SourceDate = strings.TrimSpace(body.SourceDate)
	if body.Base != "USD" {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_BASE_INVALID")
	}
	if !isExchangeRateSnapshotProvider(body.RequestedProvider) || !isExchangeRateSnapshotProvider(body.Provider) {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_PROVIDER_INVALID")
	}
	if body.SourceDate == "" || len(body.SourceDate) > 64 {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_SOURCE_DATE_INVALID")
	}
	if err := normalizeExchangeRateSnapshotRates(body.Rates); err != nil {
		return err
	}
	if body.Warning != nil {
		if err := normalizeExchangeRateCoverageWarning(body.Warning); err != nil {
			return err
		}
	}
	return nil
}

func normalizeExchangeRateSnapshotDTO(snapshot *exchangeRateSnapshotDTO) error {
	snapshot.Month = strings.TrimSpace(snapshot.Month)
	snapshot.CapturedAt = strings.TrimSpace(snapshot.CapturedAt)
	body := exchangeRateSnapshotBody{
		Base:              snapshot.Base,
		Rates:             snapshot.Rates,
		RequestedProvider: snapshot.RequestedProvider,
		Provider:          snapshot.Provider,
		SourceDate:        snapshot.SourceDate,
		Warning:           snapshot.Warning,
	}
	if snapshot.SchemaVersion != 1 {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_SCHEMA_INVALID")
	}
	if !exchangeRateSnapshotMonthRe.MatchString(snapshot.Month) {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_MONTH_INVALID")
	}
	if snapshot.CapturedAt == "" {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_CAPTURED_AT_INVALID")
	}
	if _, err := time.Parse(time.RFC3339Nano, snapshot.CapturedAt); err != nil {
		if _, fallbackErr := time.Parse(time.RFC3339, snapshot.CapturedAt); fallbackErr != nil {
			return errors.New("EXCHANGE_RATE_SNAPSHOT_CAPTURED_AT_INVALID")
		}
	}
	if err := normalizeExchangeRateSnapshotBody(&body); err != nil {
		return err
	}
	snapshot.Base = body.Base
	snapshot.Rates = body.Rates
	snapshot.RequestedProvider = body.RequestedProvider
	snapshot.Provider = body.Provider
	snapshot.SourceDate = body.SourceDate
	snapshot.Warning = body.Warning
	return nil
}

func normalizeExchangeRateSnapshotRates(rates map[string]float64) error {
	if len(rates) == 0 {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_RATES_INVALID")
	}
	for currency, rate := range rates {
		if !currencyCodeRe.MatchString(currency) || math.IsNaN(rate) || math.IsInf(rate, 0) || rate <= 0 {
			return errors.New("EXCHANGE_RATE_SNAPSHOT_RATES_INVALID")
		}
	}
	if rates["USD"] != 1 {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_USD_RATE_INVALID")
	}
	return nil
}

func normalizeExchangeRateCoverageWarning(warning *exchangeRateCoverageWarningDTO) error {
	warning.Kind = strings.TrimSpace(warning.Kind)
	warning.Provider = strings.TrimSpace(warning.Provider)
	if warning.Kind != "partial" || !isExchangeRateSnapshotProvider(warning.Provider) {
		return errors.New("EXCHANGE_RATE_SNAPSHOT_WARNING_INVALID")
	}
	for index := range warning.MissingCurrencies {
		currency := strings.ToUpper(strings.TrimSpace(warning.MissingCurrencies[index]))
		if !currencyCodeRe.MatchString(currency) {
			return errors.New("EXCHANGE_RATE_SNAPSHOT_WARNING_INVALID")
		}
		warning.MissingCurrencies[index] = currency
	}
	if warning.FillSources == nil {
		warning.FillSources = map[string]string{}
	}
	for currency, source := range warning.FillSources {
		normalizedCurrency := strings.ToUpper(strings.TrimSpace(currency))
		if normalizedCurrency != currency {
			delete(warning.FillSources, currency)
		}
		if !currencyCodeRe.MatchString(normalizedCurrency) || !isExchangeRateSource(source) {
			return errors.New("EXCHANGE_RATE_SNAPSHOT_WARNING_INVALID")
		}
		warning.FillSources[normalizedCurrency] = source
	}
	return nil
}

func isExchangeRateSnapshotProvider(value string) bool {
	return value == "frankfurter" || value == "floatrates" || value == "exchange-api"
}

func isExchangeRateSource(value string) bool {
	return isExchangeRateSnapshotProvider(value) || value == "builtin"
}

func normalizeExchangeRateSnapshotRecord(record *core.Record) error {
	snapshot, err := exchangeRateSnapshotFromRecord(record)
	if err != nil {
		return err
	}
	if err := normalizeExchangeRateSnapshotDTO(&snapshot); err != nil {
		return err
	}
	record.Set("reportMonth", snapshot.Month)
	record.Set("base", snapshot.Base)
	record.Set("rates", snapshot.Rates)
	record.Set("requestedProvider", snapshot.RequestedProvider)
	record.Set("provider", snapshot.Provider)
	record.Set("sourceDate", snapshot.SourceDate)
	record.Set("capturedAt", snapshot.CapturedAt)
	if snapshot.Warning != nil {
		record.Set("warning", snapshot.Warning)
	} else {
		record.Set("warning", nil)
	}
	return nil
}

func exchangeRateSnapshotFromRecord(record *core.Record) (exchangeRateSnapshotDTO, error) {
	rates, err := exchangeRateRatesFromValue(record.Get("rates"))
	if err != nil {
		return exchangeRateSnapshotDTO{}, err
	}
	warning, err := exchangeRateWarningFromValue(record.Get("warning"))
	if err != nil {
		return exchangeRateSnapshotDTO{}, err
	}
	return exchangeRateSnapshotDTO{
		SchemaVersion:     1,
		Month:             record.GetString("reportMonth"),
		Base:              record.GetString("base"),
		Rates:             rates,
		RequestedProvider: record.GetString("requestedProvider"),
		Provider:          record.GetString("provider"),
		SourceDate:        record.GetString("sourceDate"),
		CapturedAt:        record.GetString("capturedAt"),
		Warning:           warning,
	}, nil
}

func exchangeRateRatesFromValue(value interface{}) (map[string]float64, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil {
		return nil, err
	}
	var rates map[string]float64
	if err := json.Unmarshal(data, &rates); err != nil {
		return nil, err
	}
	return rates, nil
}

func exchangeRateWarningFromValue(value interface{}) (*exchangeRateCoverageWarningDTO, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 || string(data) == "null" {
		return nil, nil
	}
	var warning exchangeRateCoverageWarningDTO
	if err := json.Unmarshal(data, &warning); err != nil {
		return nil, err
	}
	return &warning, nil
}

func handleExchangeRateSnapshotsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	from := strings.TrimSpace(e.Request.URL.Query().Get("from"))
	to := strings.TrimSpace(e.Request.URL.Query().Get("to"))
	if (from != "" && !exchangeRateSnapshotMonthRe.MatchString(from)) || (to != "" && !exchangeRateSnapshotMonthRe.MatchString(to)) || (from != "" && to != "" && from > to) {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	snapshots, err := listExchangeRateSnapshots(app, e.Auth.Id, from, to)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, exchangeRateSnapshotsResponse{Snapshots: snapshots})
}

func handleExchangeRateSnapshotPut(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	month := strings.TrimSpace(e.Request.PathValue("month"))
	if !exchangeRateSnapshotMonthRe.MatchString(month) {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	currentMonth := time.Now().UTC().Format("2006-01")
	if month != currentMonth {
		// 登录态 capture 只允许写当前月；历史月份只能由 ZIP 恢复带入，防止当前汇率污染已关闭报表。
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	body, err := decodeStrictJSON[exchangeRateSnapshotBody](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	snapshot := exchangeRateSnapshotDTO{
		SchemaVersion:     1,
		Month:             month,
		Base:              body.Base,
		Rates:             body.Rates,
		RequestedProvider: body.RequestedProvider,
		Provider:          body.Provider,
		SourceDate:        body.SourceDate,
		CapturedAt:        time.Now().UTC().Format(time.RFC3339Nano),
		Warning:           body.Warning,
	}
	if err := upsertExchangeRateSnapshot(app, e.Auth.Id, snapshot); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, exchangeRateSnapshotResponse{Snapshot: snapshot})
}

func listExchangeRateSnapshots(app core.App, userID string, from string, to string) ([]exchangeRateSnapshotDTO, error) {
	filter := "user = {:user}"
	params := dbx.Params{"user": userID}
	if from != "" {
		filter += " && reportMonth >= {:from}"
		params["from"] = from
	}
	if to != "" {
		filter += " && reportMonth <= {:to}"
		params["to"] = to
	}
	rows, err := app.FindRecordsByFilter("exchange_rate_snapshots", filter, "reportMonth", maxExchangeRateSnapshotsPerUser, 0, params)
	if err != nil {
		return nil, err
	}
	snapshots := make([]exchangeRateSnapshotDTO, 0, len(rows))
	for _, row := range rows {
		snapshot, err := exchangeRateSnapshotFromRecord(row)
		if err != nil {
			return nil, err
		}
		if err := normalizeExchangeRateSnapshotDTO(&snapshot); err != nil {
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

func upsertExchangeRateSnapshot(app core.App, userID string, snapshot exchangeRateSnapshotDTO) error {
	if err := normalizeExchangeRateSnapshotDTO(&snapshot); err != nil {
		return err
	}
	record, err := app.FindFirstRecordByFilter(
		"exchange_rate_snapshots",
		"user = {:user} && reportMonth = {:month}",
		dbx.Params{"user": userID, "month": snapshot.Month},
	)
	if err != nil {
		if !errorsIsNoRows(err) {
			return err
		}
		collection, collectionErr := app.FindCollectionByNameOrId("exchange_rate_snapshots")
		if collectionErr != nil {
			return collectionErr
		}
		record = core.NewRecord(collection)
		record.Set("user", userID)
	}
	setExchangeRateSnapshotRecord(record, snapshot)
	return app.Save(record)
}

func setExchangeRateSnapshotRecord(record *core.Record, snapshot exchangeRateSnapshotDTO) {
	record.Set("reportMonth", snapshot.Month)
	record.Set("base", snapshot.Base)
	record.Set("rates", snapshot.Rates)
	record.Set("requestedProvider", snapshot.RequestedProvider)
	record.Set("provider", snapshot.Provider)
	record.Set("sourceDate", snapshot.SourceDate)
	record.Set("capturedAt", snapshot.CapturedAt)
	if snapshot.Warning != nil {
		record.Set("warning", snapshot.Warning)
	} else {
		record.Set("warning", nil)
	}
}

func applyImportedExchangeRateSnapshots(app core.App, user *core.Record, snapshots []exchangeRateSnapshotDTO) error {
	for _, snapshot := range snapshots {
		// 导入恢复是唯一可写历史月份的路径；只消费 ZIP data.json 的规范化快照，不保存 provider raw response。
		if err := upsertExchangeRateSnapshot(app, user.Id, snapshot); err != nil {
			return err
		}
	}
	return nil
}

func cloudBackupExportExchangeRateSnapshots(app core.App, user *core.Record) ([]exchangeRateSnapshotDTO, bool, error) {
	snapshots, err := listExchangeRateSnapshots(app, user.Id, "", "")
	if err != nil {
		return nil, false, err
	}
	if len(snapshots) == 0 {
		return nil, false, nil
	}
	return snapshots, true, nil
}

func exchangeRatePublicBasisForUser(app core.App, userID string, now time.Time) exchangeRatePublicBasis {
	month := now.UTC().Format("2006-01")
	record, err := app.FindFirstRecordByFilter(
		"exchange_rate_snapshots",
		"user = {:user} && reportMonth = {:month}",
		dbx.Params{"user": userID, "month": month},
	)
	if err != nil {
		return exchangeRatePublicBasis{Status: "live", Month: month}
	}
	snapshot, err := exchangeRateSnapshotFromRecord(record)
	if err != nil || normalizeExchangeRateSnapshotDTO(&snapshot) != nil {
		return exchangeRatePublicBasis{Status: "live", Month: month}
	}
	// 公开页只暴露 normalized rates 和非密 metadata；provider、warning、owner 与存储细节都留在登录态边界内。
	return exchangeRatePublicBasis{
		Status:     "locked",
		Month:      snapshot.Month,
		Base:       snapshot.Base,
		Rates:      snapshot.Rates,
		SourceDate: snapshot.SourceDate,
		CapturedAt: snapshot.CapturedAt,
	}
}
