package main

// ai_provider_response.go 收敛 AI provider 原始响应回显契约。
//
// 该结构只随当前认证错误响应返回给前端，不写日志、不入库、不进导出；request headers/API key 仍不可回显。
import (
	"errors"
	"net/http"

	"github.com/zendev-sh/goai"
)

type aiProviderResponse = upstreamProviderResponse

func aiProviderResponseFromHTTPResponse(response *http.Response, body string, secrets ...string) *aiProviderResponse {
	if response == nil {
		return nil
	}
	return upstreamProviderResponseFromBody(response, redactAIRecognitionSecrets(body), false, secrets)
}

func aiProviderResponseFromError(err error) *aiProviderResponse {
	if err == nil {
		return nil
	}
	var apiErr *goai.APIError
	if errors.As(err, &apiErr) {
		status := apiErr.StatusCode
		return &aiProviderResponse{
			Status:        optionalAIProviderStatus(status),
			StatusText:    optionalUpstreamString(http.StatusText(status)),
			Headers:       upstreamHeaderMapToObject(apiErr.ResponseHeaders, nil),
			Body:          optionalUpstreamBody(redactAIRecognitionSecrets(apiErr.ResponseBody)),
			BodyTruncated: false,
		}
	}
	var overflowErr *goai.ContextOverflowError
	if errors.As(err, &overflowErr) {
		return &aiProviderResponse{
			Status:        nil,
			StatusText:    nil,
			Headers:       nil,
			Body:          optionalUpstreamBody(redactAIRecognitionSecrets(overflowErr.ResponseBody)),
			BodyTruncated: false,
		}
	}
	return nil
}

func optionalAIProviderStatus(status int) *int {
	if status < 100 || status > 599 {
		return nil
	}
	return &status
}
