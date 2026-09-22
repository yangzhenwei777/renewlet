package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const moneyDecimalScale = 6
const moneyScaleFactor int64 = 1_000_000
const maxMoneyUnits int64 = int64(maxSubscriptionPrice) * moneyScaleFactor

var errInvalidMoney = errors.New("invalid money")

// Money string 是 Docker/Cloudflare/前端共同的金额事实源；只在迁移旧 number 时临时接受 numeric 输入。
func canonicalMoneyString(input string) (string, error) {
	value := strings.TrimSpace(input)
	if value == "" {
		return "", errInvalidMoney
	}
	parts := strings.Split(value, ".")
	if len(parts) > 2 {
		return "", errInvalidMoney
	}
	if parts[0] == "" {
		return "", errInvalidMoney
	}
	integer := strings.TrimLeft(parts[0], "0")
	if integer == "" {
		integer = "0"
	}
	for _, char := range integer {
		if char < '0' || char > '9' {
			return "", errInvalidMoney
		}
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
		if fraction == "" || len(fraction) > moneyDecimalScale {
			return "", errInvalidMoney
		}
		for _, char := range fraction {
			if char < '0' || char > '9' {
				return "", errInvalidMoney
			}
		}
	}
	canonical := integer
	if fraction != "" {
		fraction = strings.TrimRight(fraction, "0")
		if fraction != "" {
			canonical += "." + fraction
		}
	}
	units, err := moneyUnits(canonical)
	if err != nil || units > maxMoneyUnits {
		return "", errInvalidMoney
	}
	return canonical, nil
}

func canonicalMoneyFromValue(value any) (string, error) {
	switch typed := value.(type) {
	case string:
		return canonicalMoneyString(typed)
	case json.Number:
		return canonicalMoneyFromNumberString(typed.String())
	case float64:
		return canonicalMoneyFromFloat(typed)
	case float32:
		return canonicalMoneyFromFloat(float64(typed))
	case int:
		return canonicalMoneyString(strconv.Itoa(typed))
	case int64:
		return canonicalMoneyString(strconv.FormatInt(typed, 10))
	case nil:
		return "", errInvalidMoney
	default:
		return "", errInvalidMoney
	}
}

func canonicalMoneyFromFloat(value float64) (string, error) {
	if !isValidMoneyFloat(value) {
		return "", errInvalidMoney
	}
	return canonicalMoneyString(strconv.FormatFloat(value, 'f', moneyDecimalScale, 64))
}

func canonicalMoneyFromNumberString(value string) (string, error) {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return "", errInvalidMoney
	}
	return canonicalMoneyFromFloat(parsed)
}

func moneyForRecord(recordValue any) string {
	value, err := canonicalMoneyFromValue(recordValue)
	if err == nil {
		return value
	}
	return "0"
}

func isValidMoneyFloat(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= maxSubscriptionPrice
}

func moneyUnits(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, "+-eE") {
		return 0, errInvalidMoney
	}
	parts := strings.Split(value, ".")
	if len(parts) > 2 {
		return 0, errInvalidMoney
	}
	integer, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, err
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	fraction = (fraction + strings.Repeat("0", moneyDecimalScale))[:moneyDecimalScale]
	fractionUnits, err := strconv.ParseInt(fraction, 10, 64)
	if err != nil {
		return 0, err
	}
	return integer*moneyScaleFactor + fractionUnits, nil
}

func divideMoneyString(value string, denominator int) string {
	if denominator <= 0 {
		return "0"
	}
	units, err := moneyUnits(moneyForRecord(value))
	if err != nil {
		return "0"
	}
	// 家庭共享 equal 模式按最小金额单位四舍五入，避免 float 平分在 Go/Worker 间出现尾差。
	return moneyUnitsToString(roundMoneyUnitsDiv(units, int64(denominator)))
}

func roundMoneyUnitsDiv(numerator int64, denominator int64) int64 {
	if denominator <= 0 {
		return 0
	}
	quotient := numerator / denominator
	remainder := numerator % denominator
	if remainder*2 >= denominator {
		return quotient + 1
	}
	return quotient
}

func moneyUnitsToString(units int64) string {
	if units <= 0 {
		return "0"
	}
	integer := units / moneyScaleFactor
	fraction := units % moneyScaleFactor
	if fraction == 0 {
		return strconv.FormatInt(integer, 10)
	}
	return strconv.FormatInt(integer, 10) + "." + strings.TrimRight(fmt.Sprintf("%06d", fraction), "0")
}
