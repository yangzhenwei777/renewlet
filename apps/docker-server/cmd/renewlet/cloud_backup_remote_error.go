package main

// 云备份错误只描述一次真实的远端阶段；状态记录只保存 code，完整详情只随当前认证请求返回。
import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type cloudBackupProviderResponse = upstreamProviderResponse

type cloudBackupErrorDetails struct {
	Provider           string                       `json:"provider,omitempty"`
	Operation          string                       `json:"operation"`
	Target             string                       `json:"target"`
	HTTPStatus         *int                         `json:"httpStatus,omitempty"`
	HTTPStatusText     string                       `json:"httpStatusText,omitempty"`
	ProviderCode       string                       `json:"providerCode,omitempty"`
	ProviderMessage    string                       `json:"providerMessage,omitempty"`
	ClientMessage      string                       `json:"clientMessage,omitempty"`
	RequestID          string                       `json:"requestId,omitempty"`
	RequiredCapability string                       `json:"requiredCapability,omitempty"`
	Cleanup            []cloudBackupCleanupError    `json:"cleanup,omitempty"`
	Attempts           []cloudBackupProviderAttempt `json:"attempts,omitempty"`
}

type cloudBackupCleanupError struct {
	Operation string `json:"operation"`
	Target    string `json:"target"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// cloudBackupProviderAttempt 保留多目标解析中每个 provider 的原始阶段码，禁止拼接成不可解析的文本。
type cloudBackupProviderAttempt struct {
	Provider string                   `json:"provider"`
	Code     string                   `json:"code"`
	Details  *cloudBackupErrorDetails `json:"details,omitempty"`
}

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

func cloudBackupProviderAttemptsError(code string, attempts []cloudBackupProviderAttempt) error {
	return &cloudBackupRemoteError{
		code: code,
		details: &cloudBackupErrorDetails{
			Operation: "provider-resolution",
			Target:    "configured cloud backup targets",
			Attempts:  attempts,
		},
	}
}

func cloudBackupProviderAttemptFromError(provider, fallbackCode string, err error) cloudBackupProviderAttempt {
	if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil {
		return cloudBackupProviderAttempt{Provider: provider, Code: remoteErr.code, Details: remoteErr.details}
	}
	return cloudBackupProviderAttempt{
		Provider: provider,
		Code:     fallbackCode,
		Details: &cloudBackupErrorDetails{
			Operation:     "local",
			Target:        "cloud backup",
			ClientMessage: truncateCloudBackupDiagnostic(errorMessage(err)),
		},
	}
}

func cloudBackupLocalErrorDetails(provider, operation, target, message string) *cloudBackupErrorDetails {
	details := &cloudBackupErrorDetails{
		Operation:     strings.TrimSpace(operation),
		Target:        cloudBackupTargetSummary(target),
		ClientMessage: truncateCloudBackupDiagnostic(message),
	}
	if provider = strings.TrimSpace(provider); provider != "" && provider != "local" {
		details.Provider = provider
	}
	return details
}

func cloudBackupRemoteErrorDetails(provider, operation, target string, response *cloudBackupProviderResponse, clientMessage string) *cloudBackupErrorDetails {
	// 远端正文与 SDK/网络异常各自保留，HTTP 2xx 不能抹掉本地解析失败的原因。
	details := cloudBackupLocalErrorDetails(provider, operation, target, clientMessage)
	if response != nil {
		details.HTTPStatus = response.Status
		if response.StatusText != nil {
			details.HTTPStatusText = strings.TrimSpace(*response.StatusText)
		}
		if response.Body != nil {
			details.ProviderMessage = truncateCloudBackupDiagnostic(strings.TrimSpace(*response.Body))
		}
		if requestID := cloudBackupRequestID(response); requestID != "" {
			details.RequestID = requestID
		}
		if details.ProviderCode == "" && response.Body != nil {
			details.ProviderCode = providerCodeFromDiagnosticBody(*response.Body)
		}
	}
	if details.HTTPStatus != nil {
		details.RequiredCapability = cloudBackupRequiredCapability(details.Operation, *details.HTTPStatus)
	}
	return details
}

var cloudBackupProviderCodeXMLRe = regexp.MustCompile(`(?is)<(?:[A-Za-z0-9_.-]+:)?Code>\s*([^<\s][^<]{0,255}?)\s*</`)
var cloudBackupProviderCodeJSONRe = regexp.MustCompile(`(?i)"(?:Code|code)"\s*:\s*"([^"]{1,256})"`)
var cloudBackupStableCodeRe = regexp.MustCompile(`^CLOUD_BACKUP_[A-Z0-9_]+$`)

func providerCodeFromDiagnosticBody(body string) string {
	if match := cloudBackupProviderCodeXMLRe.FindStringSubmatch(body); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	if match := cloudBackupProviderCodeJSONRe.FindStringSubmatch(body); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	return ""
}

// target 只保留 host 与 path，避免把完整 URL、query 或签名参数带入错误详情。
func cloudBackupTargetSummary(target string) string {
	target = strings.TrimSpace(target)
	parsed, err := url.Parse(target)
	if err == nil && parsed.Host != "" {
		pathValue := parsed.EscapedPath()
		if pathValue == "" {
			pathValue = "/"
		}
		return sanitizeCloudBackupTarget("host=" + parsed.Host + "; path=" + pathValue)
	}
	return sanitizeCloudBackupTarget(target)
}

func sanitizeCloudBackupTarget(value string) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(value))
	if len(value) > 1024 {
		return value[:1024] + "…"
	}
	return value
}

func cloudBackupEndpointHost(target string) string {
	parsed, err := url.Parse(strings.TrimSpace(target))
	if err != nil {
		return ""
	}
	return parsed.Host
}

func cloudBackupRequestID(response *cloudBackupProviderResponse) string {
	if response == nil || len(response.Headers) == 0 {
		return ""
	}
	for key, value := range response.Headers {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "x-amz-request-id", "x-amz-id-2", "x-request-id", "request-id":
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func cloudBackupRequiredCapability(operation string, status int) string {
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		return ""
	}
	switch strings.ToUpper(strings.TrimSpace(operation)) {
	case "PUT", "PUTOBJECT", "MKCOL":
		return "object write permission"
	case "HEAD", "HEADOBJECT", "GET", "GETOBJECT":
		return "object read permission"
	case "LISTOBJECTSV2", "LIST", "PROPFIND", "PROPFIND-DIRECTORY":
		return "bucket listing permission"
	case "DELETE", "DELETEOBJECT":
		return "object delete permission"
	default:
		return ""
	}
}

func cloudBackupRemoteErrorFrom(err error) *cloudBackupRemoteError {
	var remoteErr *cloudBackupRemoteError
	if errors.As(err, &remoteErr) {
		return remoteErr
	}
	return nil
}

func cloudBackupErrorWithCleanup(primary error, cleanup []cloudBackupCleanupError) error {
	if len(cleanup) == 0 {
		return primary
	}
	if remoteErr := cloudBackupRemoteErrorFrom(primary); remoteErr != nil {
		if remoteErr.details == nil {
			remoteErr.details = &cloudBackupErrorDetails{Operation: "upload", Target: "cloud backup"}
		}
		remoteErr.details.Cleanup = append(remoteErr.details.Cleanup, cleanup...)
		if len(remoteErr.details.Cleanup) > 4 {
			remoteErr.details.Cleanup = remoteErr.details.Cleanup[:4]
		}
		return remoteErr
	}
	return &cloudBackupRemoteError{code: "CLOUD_BACKUP_UPLOAD_FAILED", details: &cloudBackupErrorDetails{Operation: "upload", Target: "cloud backup", ClientMessage: truncateCloudBackupDiagnostic(errorMessage(primary)), Cleanup: cleanup}}
}

func cloudBackupProviderResponseAndBodyFromHTTPResponse(response *http.Response, secrets []string) (*cloudBackupProviderResponse, string) {
	providerResponse, body, err := captureUpstreamProviderResponse(response, secrets)
	if err != nil {
		return nil, ""
	}
	return providerResponse, body
}

func cloudBackupProviderResponseFromBody(response *http.Response, body []byte, truncated bool, secrets []string) *cloudBackupProviderResponse {
	if response == nil {
		return nil
	}
	copyResponse := *response
	copyResponse.Body = io.NopCloser(bytes.NewReader(body))
	providerResponse, _, err := captureUpstreamProviderResponse(&copyResponse, secrets)
	if err != nil || providerResponse == nil {
		return nil
	}
	providerResponse.BodyTruncated = providerResponse.BodyTruncated || truncated
	return providerResponse
}

func truncateCloudBackupDiagnostic(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= upstreamProviderResponseCaptureBodyMaxBytes {
		return value
	}
	return value[:upstreamProviderResponseCaptureBodyMaxBytes]
}

func errorMessage(err error) string {
	if err == nil {
		return "unknown error"
	}
	return err.Error()
}

func cloudBackupDiagnosticMessage(details *cloudBackupErrorDetails, fallback string) string {
	if details != nil && details.ClientMessage != "" {
		return details.ClientMessage
	}
	if details != nil && details.ProviderMessage != "" {
		return details.ProviderMessage
	}
	return fallback
}

func persistedCloudBackupErrorMessage(err error) string {
	if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil {
		return remoteErr.code
	}
	if candidate := stableCloudBackupErrorCode(errorMessage(err)); candidate != "" {
		return candidate
	}
	return "local_sdk_error"
}

func stableCloudBackupErrorCode(value string) string {
	candidate := strings.TrimSpace(value)
	if cloudBackupStableCodeRe.MatchString(candidate) {
		return candidate
	}
	return ""
}

func formatCloudBackupCleanupError(operation, target string, err error) cloudBackupCleanupError {
	code := "CLOUD_BACKUP_CLEANUP_FAILED"
	message := errorMessage(err)
	if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil {
		code = remoteErr.code
		message = cloudBackupDiagnosticMessage(remoteErr.details, remoteErr.code)
	}
	return cloudBackupCleanupError{Operation: operation, Target: target, Code: code, Message: truncateCloudBackupDiagnostic(message)}
}

func cloudBackupDiagnosticError(code, provider, operation, target, message string) error {
	return &cloudBackupRemoteError{code: code, details: cloudBackupLocalErrorDetails(provider, operation, target, fmt.Sprint(message))}
}
