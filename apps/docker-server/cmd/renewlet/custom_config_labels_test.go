package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestConfigLabelLocaleContract(t *testing.T) {
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/config-label-locales.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string               `json:"name"`
		Key      *string              `json:"key"`
		Value    string               `json:"value"`
		Labels   customConfigLabels   `json:"labels"`
		Expected map[appLocale]string `json:"expected"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			for _, locale := range supportedAppLocales {
				item := customConfigItem{ID: "item", Value: fixture.Value, Labels: fixture.Labels}
				key := ""
				if fixture.Key != nil {
					key = *fixture.Key
				}
				if got := localizedCustomConfigLabel(fixture.Labels, locale, key); got != fixture.Expected[locale] {
					t.Errorf("localized label %s = %q, want %q", locale, got, fixture.Expected[locale])
				}
				if aiOptions := aiRecognitionConfigOptions([]customConfigItem{item}, locale, func(string) (string, bool) {
					return key, key != ""
				}); aiOptions[0].Label != fixture.Expected[locale] {
					t.Errorf("AI context %s label = %q, want %q", locale, aiOptions[0].Label, fixture.Expected[locale])
				} else if aiOptions[0].ZhCN != fixture.Labels.ZhCN || aiOptions[0].EnUS != fixture.Labels.EnUS {
					t.Fatal("AI context changed persisted labels")
				}
			}
		})
	}
}

func TestConfigLabelLocaleContractRejectsTextCollision(t *testing.T) {
	labels := customConfigLabels{ZhCN: "其他", EnUS: "Other"}
	if got := localizedCustomConfigLabel(labels, localeRuRU, ""); got != "Other" {
		t.Fatalf("custom colliding label = %q, want Other", got)
	}
}
