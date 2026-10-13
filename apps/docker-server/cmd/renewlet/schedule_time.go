package main

import (
	"fmt"
	"strconv"
	"time"
)

func getScheduleInstant(localDate, localTime, timezone string) (time.Time, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, fmt.Errorf("load schedule timezone: %w", err)
	}
	day, err := time.Parse("2006-01-02", localDate)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse schedule date: %w", err)
	}
	if !isValidLocalTime(localTime) {
		return time.Time{}, fmt.Errorf("invalid schedule local time: %q", localTime)
	}
	hour, minute := parseLocalTime(localTime)
	wall := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, time.UTC)
	guess := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, loc)
	// time.Date在跳时/回拨时不保证选哪一侧；检查所属区间和相邻转换的真实偏移，不假设DST只变化一小时。
	_, offset := guess.Zone()
	offsets := []int{offset}
	start, end := guess.ZoneBounds()
	if !start.IsZero() {
		_, prior := start.Add(-time.Nanosecond).In(loc).Zone()
		offsets = append(offsets, prior)
	}
	if !end.IsZero() {
		_, next := end.In(loc).Zone()
		offsets = append(offsets, next)
	}
	var first, shifted time.Time
	var shift time.Duration
	for _, zoneOffset := range offsets {
		candidate := wall.Add(-time.Duration(zoneOffset) * time.Second)
		local := candidate.In(loc)
		shown := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), 0, time.UTC)
		if shown.Equal(wall) && (first.IsZero() || candidate.Before(first)) {
			first = candidate
		}
		if shown.After(wall) && (shifted.IsZero() || shown.Sub(wall) < shift) {
			shifted, shift = candidate, shown.Sub(wall)
		}
	}
	// 对齐Temporal compatible：回拨取首次；缺失时间保留分钟并按时区跳变量顺延。
	if !first.IsZero() {
		return first, nil
	}
	if !shifted.IsZero() {
		return shifted, nil
	}
	return time.Time{}, fmt.Errorf("resolve schedule wall time in %s", timezone)
}

func isValidLocalTime(value string) bool {
	if len(value) != 5 || value[2] != ':' {
		return false
	}
	hour, errH := strconv.Atoi(value[:2])
	minute, errM := strconv.Atoi(value[3:])
	return errH == nil && errM == nil && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

func parseLocalTime(value string) (int, int) {
	hour, _ := strconv.Atoi(value[:2])
	minute, _ := strconv.Atoi(value[3:])
	return hour, minute
}
