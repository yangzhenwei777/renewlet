package main

import (
	"encoding/json"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
)

// 产品DTO的省略/null规则是与Worker共享的API契约，不能随PocketBase的JSON默认值改变。
// 在envelope固定编码策略，让普通响应与平台fields筛选共用同一语义，并保留流式写出。
func (response apiSuccessResponse) MarshalJSONTo(encoder *jsontext.Encoder) error {
	type envelope apiSuccessResponse
	return jsonv2.MarshalEncode(encoder, envelope(response), json.DefaultOptionsV1())
}

func (response apiErrorEnvelope) MarshalJSONTo(encoder *jsontext.Encoder) error {
	type envelope apiErrorEnvelope
	return jsonv2.MarshalEncode(encoder, envelope(response), json.DefaultOptionsV1())
}
