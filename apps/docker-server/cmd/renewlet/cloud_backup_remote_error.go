package main

// 云备份上游响应只随当前认证错误返回给操作者；不能写入 last_error、日志、导出或备份包。
import (
	"errors"
	"net/http"
	"strings"
)

type cloudBackupProviderResponse = upstreamProviderResponse

// cloudBackupErrorDetails 复用 shared upstream 口径，只暴露 rawResponseText 给当前操作者。
type cloudBackupErrorDetails struct {
	RawResponseText *string `json:"rawResponseText,omitempty"`
}

// cloudBackupProviderAttempt 描述一次 provider 尝试结果，用于“缺 provider 时自动查找”的失败汇总。
type cloudBackupProviderAttempt struct {
	Provider string
	Code     string
	Message  string
}

// cloudBackupRemoteError 标记远端 WebDAV/S3 失败，区别于本地 ZIP/manifest 校验错误。
type cloudBackupRemoteError struct {
	code    string
	details *cloudBackupErrorDetails
}

func (err *cloudBackupRemoteError) Error() string {
	if err == nil {
		return ""
	}
	return err.code
}

func cloudBackupRemoteHTTPError(code string, response *http.Response, secrets ...string) error {
	return &cloudBackupRemoteError{
		code:    code,
		details: cloudBackupRemoteErrorDetails(code, response, secrets),
	}
}

func cloudBackupRemoteHTTPErrorFromProviderResponse(code string, response *cloudBackupProviderResponse) error {
	return &cloudBackupRemoteError{
		code:    code,
		details: cloudBackupRemoteErrorDetailsFromProviderResponse(code, response),
	}
}

func cloudBackupProviderAttemptsError(code string, message string, attempts []cloudBackupProviderAttempt) error {
	return &cloudBackupRemoteError{
		code: code,
		details: &cloudBackupErrorDetails{
			RawResponseText: optionalCloudBackupString(cloudBackupProviderAttemptsText(message, attempts)),
		},
	}
}

func cloudBackupProviderAttemptFromError(provider string, fallbackCode string, fallbackReason string, err error) cloudBackupProviderAttempt {
	if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil {
		return cloudBackupProviderAttempt{Provider: provider, Code: remoteErr.code, Message: cloudBackupRawResponseText(remoteErr.details, fallbackReason)}
	}
	return cloudBackupProviderAttempt{
		Provider: provider,
		Code:     fallbackCode,
		Message:  err.Error(),
	}
}

func cloudBackupLocalErrorDetails(err error) *cloudBackupErrorDetails {
	return &cloudBackupErrorDetails{
		RawResponseText: optionalCloudBackupString(err.Error()),
	}
}

func cloudBackupRemoteErrorDetails(code string, response *http.Response, secrets []string) *cloudBackupErrorDetails {
	providerResponse := cloudBackupProviderResponseFromHTTPResponse(response, secrets)
	return cloudBackupRemoteErrorDetailsFromProviderResponse(code, providerResponse)
}

func cloudBackupRemoteErrorDetailsFromProviderResponse(code string, providerResponse *cloudBackupProviderResponse) *cloudBackupErrorDetails {
	message := code
	if providerResponse != nil && providerResponse.Body != nil {
		message = *providerResponse.Body
	} else if providerResponse != nil && providerResponse.StatusText != nil {
		message = *providerResponse.StatusText
	}
	return &cloudBackupErrorDetails{
		RawResponseText: optionalCloudBackupString(message),
	}
}

func cloudBackupProviderResponseFromHTTPResponse(response *http.Response, secrets []string) *cloudBackupProviderResponse {
	providerResponse, _ := cloudBackupProviderResponseAndBodyFromHTTPResponse(response, secrets)
	return providerResponse
}

func cloudBackupProviderResponseAndBodyFromHTTPResponse(response *http.Response, secrets []string) (*cloudBackupProviderResponse, string) {
	providerResponse, body, err := captureUpstreamProviderResponse(response, secrets)
	if err != nil {
		return nil, ""
	}
	return providerResponse, body
}

func optionalCloudBackupString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func cloudBackupRemoteErrorFrom(err error) *cloudBackupRemoteError {
	var remoteErr *cloudBackupRemoteError
	if errors.As(err, &remoteErr) {
		return remoteErr
	}
	return nil
}

func cloudBackupProviderAttemptsText(message string, attempts []cloudBackupProviderAttempt) string {
	lines := []string{message}
	for _, attempt := range attempts {
		lines = append(lines, strings.TrimSpace(attempt.Provider+": "+attempt.Code+" "+attempt.Message))
	}
	return strings.Join(lines, "\n")
}

func cloudBackupRawResponseText(details *cloudBackupErrorDetails, fallback string) string {
	if details != nil && details.RawResponseText != nil && strings.TrimSpace(*details.RawResponseText) != "" {
		return *details.RawResponseText
	}
	return fallback
}
