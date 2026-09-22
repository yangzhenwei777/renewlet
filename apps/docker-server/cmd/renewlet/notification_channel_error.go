package main

import "errors"

// notificationChannelError 只用于手动测试/手动运行的当前响应携带 rawResponseText；cron 历史保存时必须摘要化。
type notificationChannelError struct {
	message string
	details *upstreamErrorDetails
}

func (err *notificationChannelError) Error() string {
	if err == nil {
		return ""
	}
	return err.message
}

func newNotificationChannelError(message string, details *upstreamErrorDetails) error {
	return &notificationChannelError{message: message, details: details}
}

func notificationChannelErrorFrom(err error) *notificationChannelError {
	var channelErr *notificationChannelError
	if errors.As(err, &channelErr) {
		return channelErr
	}
	return nil
}

func notificationChannelErrorDetails(err error) *upstreamErrorDetails {
	if channelErr := notificationChannelErrorFrom(err); channelErr != nil {
		return channelErr.details
	}
	return nil
}
