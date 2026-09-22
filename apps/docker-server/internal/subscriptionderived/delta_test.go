package subscriptionderived

import "testing"

func TestBetween(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		before   *Snapshot
		after    *Snapshot
		userID   string
		expected Delta
	}{
		{
			name:     "create active auto renew subscription",
			after:    &Snapshot{UserID: "user-1", Status: "active", AutoRenew: true},
			userID:   "user-1",
			expected: Delta{Total: 1, Active: 1, AutoRenew: 1},
		},
		{
			name:     "update status and repeat reminder",
			before:   &Snapshot{UserID: "user-1", Status: "trial"},
			after:    &Snapshot{UserID: "user-1", Status: "active", RepeatReminderEnabled: true},
			userID:   "user-1",
			expected: Delta{Trial: -1, Active: 1, RepeatReminder: 1},
		},
		{
			name:     "delete cancelled subscription",
			before:   &Snapshot{UserID: "user-1", Status: "cancelled", AutoRenew: true, RepeatReminderEnabled: true},
			userID:   "user-1",
			expected: Delta{Total: -1, Cancelled: -1, AutoRenew: -1, RepeatReminder: -1},
		},
		{
			name:     "ignore another owner",
			before:   &Snapshot{UserID: "user-2", Status: "active", AutoRenew: true},
			after:    &Snapshot{UserID: "user-2", Status: "paused", RepeatReminderEnabled: true},
			userID:   "user-1",
			expected: Delta{},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			actual, err := Between(test.before, test.after, test.userID)
			if err != nil {
				t.Fatal(err)
			}
			if actual != test.expected {
				t.Fatalf("expected %#v, got %#v", test.expected, actual)
			}
		})
	}
}

func TestBetweenRejectsUnknownOwnedStatus(t *testing.T) {
	t.Parallel()
	_, err := Between(nil, &Snapshot{UserID: "user-1", Status: "unknown"}, "user-1")
	if err == nil {
		t.Fatal("expected unknown status to fail")
	}
}
