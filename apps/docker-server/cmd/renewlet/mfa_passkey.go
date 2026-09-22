package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	webauthn "github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	passkeyChallengeKindRegistration   = "registration"
	passkeyChallengeKindAuthentication = "authentication"
)

// Passkey 是独立 WebAuthn 登录凭据；它可与身份验证器共存，但不进入 MFA ticket 或恢复码生命周期。
type renewletWebAuthnUser struct {
	id          []byte
	name        string
	displayName string
	credentials []webauthn.Credential
}

func (u renewletWebAuthnUser) WebAuthnID() []byte {
	return u.id
}

func (u renewletWebAuthnUser) WebAuthnName() string {
	return u.name
}

func (u renewletWebAuthnUser) WebAuthnDisplayName() string {
	return u.displayName
}

func (u renewletWebAuthnUser) WebAuthnCredentials() []webauthn.Credential {
	return u.credentials
}

func listPasskeysForUser(app core.App, userID string) (passkeysResponse, error) {
	records, err := app.FindRecordsByFilter(
		"passkey_credentials",
		"user = {:user}",
		"-created",
		200,
		0,
		dbx.Params{"user": userID},
	)
	if err != nil {
		return passkeysResponse{}, err
	}
	passkeys := make([]passkeyResponse, 0, len(records))
	for _, record := range records {
		passkeys = append(passkeys, passkeyResponseFromRecord(record))
	}
	return passkeysResponse{Passkeys: passkeys}, nil
}

func startPasskeyRegistration(app core.App, request *http.Request, user *core.Record) (passkeyWebAuthnOptionsResponse, error) {
	wa, err := newRequestWebAuthn(request)
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	waUser, err := webAuthnUserForRecord(app, user)
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	creation, sessionData, err := wa.BeginRegistration(
		waUser,
		webauthn.WithExclusions(webauthn.Credentials(waUser.WebAuthnCredentials()).CredentialDescriptors()),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	)
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	challengeID, expiresAt, err := storeWebAuthnChallenge(app, user.Id, passkeyChallengeKindRegistration, sessionData)
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	return passkeyWebAuthnOptionsResponse{
		ChallengeID: challengeID,
		ExpiresAt:   expiresAt,
		Options:     creation.Response,
	}, nil
}

func finishPasskeyRegistration(app core.App, request *http.Request, user *core.Record, challengeID string, name string, response json.RawMessage) (sessionResponse, error) {
	challenge, err := webAuthnChallengeByToken(app, challengeID, passkeyChallengeKindRegistration)
	if err != nil {
		return sessionResponse{}, err
	}
	if challenge.GetString("user") != user.Id {
		return sessionResponse{}, sql.ErrNoRows
	}
	sessionData, err := sessionDataFromChallenge(challenge)
	if err != nil {
		return sessionResponse{}, err
	}
	wa, err := newRequestWebAuthn(request)
	if err != nil {
		return sessionResponse{}, err
	}
	waUser, err := webAuthnUserForRecord(app, user)
	if err != nil {
		return sessionResponse{}, err
	}
	credentialRequest, err := webAuthnJSONRequest(request, response)
	if err != nil {
		return sessionResponse{}, err
	}
	// Go WebAuthn 库负责校验 challenge、origin、RP ID 与 attestation；Renewlet 只保存通过后的 credential。
	credential, err := wa.FinishRegistration(waUser, sessionData, credentialRequest)
	if err != nil {
		return sessionResponse{}, err
	}
	var responseBody sessionResponse
	err = app.RunInTransaction(func(txApp core.App) error {
		// 注册通行密钥后续签产品 session，避免保存新登录方式的旧 cookie session 继续流通。
		if err := savePasskeyCredential(txApp, user.Id, strings.TrimSpace(name), credential); err != nil {
			return err
		}
		txChallenge, err := txApp.FindRecordById("passkey_challenges", challenge.Id)
		if err != nil {
			return err
		}
		if err := txApp.Delete(txChallenge); err != nil {
			return err
		}
		session, err := renewAccountSecuritySession(txApp, user.Id)
		if err != nil {
			return err
		}
		responseBody = session
		return nil
	})
	if err != nil {
		return sessionResponse{}, err
	}
	return responseBody, nil
}

func startPasskeyAuthentication(app core.App, request *http.Request) (passkeyWebAuthnOptionsResponse, error) {
	wa, err := newRequestWebAuthn(request)
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	assertion, sessionData, err := wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	// Passkey 登录开始时还不知道用户；challenge 只能绑定 RP/origin，finish 时再通过 userHandle 反查账号。
	challengeID, expiresAt, err := storeWebAuthnChallenge(app, "", passkeyChallengeKindAuthentication, sessionData)
	if err != nil {
		return passkeyWebAuthnOptionsResponse{}, err
	}
	return passkeyWebAuthnOptionsResponse{
		ChallengeID: challengeID,
		ExpiresAt:   expiresAt,
		Options:     assertion.Response,
	}, nil
}

func finishPasskeyAuthentication(app core.App, request *http.Request, challengeID string, response json.RawMessage) (sessionResponse, error) {
	challenge, err := webAuthnChallengeByToken(app, challengeID, passkeyChallengeKindAuthentication)
	if err != nil {
		return sessionResponse{}, err
	}
	sessionData, err := sessionDataFromChallenge(challenge)
	if err != nil {
		return sessionResponse{}, err
	}
	wa, err := newRequestWebAuthn(request)
	if err != nil {
		return sessionResponse{}, err
	}
	credentialRequest, err := webAuthnJSONRequest(request, response)
	if err != nil {
		return sessionResponse{}, err
	}
	// FinishPasskeyLogin 通过 discoverable credential 的 userHandle 反查账号，并校验签名、origin、RP ID 和 counter。
	validatedUser, credential, err := wa.FinishPasskeyLogin(func(rawID []byte, userHandle []byte) (webauthn.User, error) {
		return webAuthnUserByHandle(app, userHandle)
	}, sessionData, credentialRequest)
	if err != nil {
		return sessionResponse{}, err
	}
	waUser, ok := validatedUser.(renewletWebAuthnUser)
	if !ok {
		return sessionResponse{}, errors.New("invalid WebAuthn user")
	}
	userID := string(waUser.WebAuthnID())
	if err := updatePasskeyCredential(app, userID, credential); err != nil {
		return sessionResponse{}, err
	}
	if err := app.Delete(challenge); err != nil {
		return sessionResponse{}, err
	}
	user, err := app.FindRecordById("users", userID)
	if err != nil {
		return sessionResponse{}, err
	}
	return createAppSessionResponse(app, user)
}

func deletePasskeyCredential(app core.App, userID string, passkeyID string) (sessionResponse, error) {
	var response sessionResponse
	err := app.RunInTransaction(func(txApp core.App) error {
		record, err := txApp.FindRecordById("passkey_credentials", passkeyID)
		if err != nil {
			return err
		}
		if record.GetString("user") != userID {
			return sql.ErrNoRows
		}
		if err := txApp.Delete(record); err != nil {
			return err
		}
		// 删除单个通行密钥也是账号安全状态切换；同用户未完成的注册 challenge 不能继续沿用旧凭据上下文。
		if err := deleteRecordsByFilter(txApp, "passkey_challenges", "user = {:user}", dbx.Params{"user": userID}); err != nil {
			return err
		}
		session, err := renewAccountSecuritySession(txApp, userID)
		if err != nil {
			return err
		}
		response = session
		return nil
	})
	if err != nil {
		return sessionResponse{}, err
	}
	return response, nil
}

func newRequestWebAuthn(request *http.Request) (*webauthn.WebAuthn, error) {
	origin := externalRequestOrigin(request)
	rpID := origin.Hostname()
	if rpID == "" {
		return nil, errors.New("invalid WebAuthn RP ID")
	}
	// WebAuthn 的 origin/RP ID 必须来自浏览器实际访问的公开地址；反代头解析失败时让库校验失败关闭。
	return webauthn.New(&webauthn.Config{
		RPID:                  rpID,
		RPDisplayName:         "Renewlet",
		RPOrigins:             []string{origin.String()},
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationPreferred,
		},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Timeout: mfaAuthTicketTTL, TimeoutUVD: mfaAuthTicketTTL},
			Registration: webauthn.TimeoutConfig{Timeout: mfaAuthTicketTTL, TimeoutUVD: mfaAuthTicketTTL},
		},
	})
}

func webAuthnUserForRecord(app core.App, user *core.Record) (renewletWebAuthnUser, error) {
	credentials, err := webAuthnCredentialsForUser(app, user.Id)
	if err != nil {
		return renewletWebAuthnUser{}, err
	}
	displayName := strings.TrimSpace(user.GetString("name"))
	if displayName == "" {
		displayName = user.Email()
	}
	return renewletWebAuthnUser{
		id:          []byte(user.Id),
		name:        user.Email(),
		displayName: displayName,
		credentials: credentials,
	}, nil
}

func webAuthnUserByHandle(app core.App, userHandle []byte) (renewletWebAuthnUser, error) {
	if len(userHandle) == 0 {
		return renewletWebAuthnUser{}, sql.ErrNoRows
	}
	user, err := app.FindRecordById("users", string(userHandle))
	if err != nil {
		return renewletWebAuthnUser{}, err
	}
	if user.GetBool("banned") {
		return renewletWebAuthnUser{}, sql.ErrNoRows
	}
	return webAuthnUserForRecord(app, user)
}

func webAuthnCredentialsForUser(app core.App, userID string) ([]webauthn.Credential, error) {
	records, err := app.FindRecordsByFilter(
		"passkey_credentials",
		"user = {:user}",
		"-created",
		200,
		0,
		dbx.Params{"user": userID},
	)
	if err != nil {
		return nil, err
	}
	credentials := make([]webauthn.Credential, 0, len(records))
	for _, record := range records {
		var credential webauthn.Credential
		if err := json.Unmarshal([]byte(record.GetString("credentialJson")), &credential); err != nil {
			return nil, err
		}
		credentials = append(credentials, credential)
	}
	return credentials, nil
}

func storeWebAuthnChallenge(app core.App, userID string, kind string, sessionData *webauthn.SessionData) (string, string, error) {
	if sessionData == nil {
		return "", "", errors.New("missing WebAuthn session data")
	}
	if userID != "" {
		// 注册 challenge 绑定登录用户且同类只保留一个；独立登录 challenge 开始时无用户，不能按空 user 批量清掉其他浏览器流程。
		if err := deleteRecordsByFilter(app, "passkey_challenges", "user = {:user} && kind = {:kind}", dbx.Params{"user": userID, "kind": kind}); err != nil {
			return "", "", err
		}
	}
	sessionDataJSON, err := json.Marshal(sessionData)
	if err != nil {
		return "", "", err
	}
	collection, err := app.FindCollectionByNameOrId("passkey_challenges")
	if err != nil {
		return "", "", err
	}
	challengeID := randomURLToken(mfaTicketTokenN)
	expiresAt := sessionData.Expires.UTC()
	if expiresAt.IsZero() || expiresAt.Before(time.Now().UTC()) {
		expiresAt = time.Now().UTC().Add(mfaAuthTicketTTL)
	}
	record := core.NewRecord(collection)
	if userID != "" {
		record.Set("user", userID)
	}
	hash, err := passkeyChallengeHash(app, challengeID)
	if err != nil {
		return "", "", err
	}
	record.Set("challengeIdHash", hash)
	record.Set("kind", kind)
	record.Set("challenge", sessionData.Challenge)
	record.Set("sessionDataJson", string(sessionDataJSON))
	record.Set("expiresAt", expiresAt.Format(time.RFC3339Nano))
	if err := app.Save(record); err != nil {
		return "", "", err
	}
	return challengeID, record.GetString("expiresAt"), nil
}

func webAuthnChallengeByToken(app core.App, token string, kind string) (*core.Record, error) {
	hash, err := passkeyChallengeHash(app, token)
	if err != nil {
		return nil, err
	}
	return app.FindFirstRecordByFilter(
		"passkey_challenges",
		"challengeIdHash = {:hash} && kind = {:kind} && expiresAt > {:now}",
		dbx.Params{"hash": hash, "kind": kind, "now": nowString()},
	)
}

func sessionDataFromChallenge(record *core.Record) (webauthn.SessionData, error) {
	var sessionData webauthn.SessionData
	if err := json.Unmarshal([]byte(record.GetString("sessionDataJson")), &sessionData); err != nil {
		return webauthn.SessionData{}, err
	}
	return sessionData, nil
}

func savePasskeyCredential(app core.App, userID string, name string, credential *webauthn.Credential) error {
	if credential == nil {
		return errors.New("missing WebAuthn credential")
	}
	if name == "" {
		name = "Passkey"
	}
	collection, err := app.FindCollectionByNameOrId("passkey_credentials")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("name", name)
	setPasskeyCredentialFields(record, credential)
	return app.Save(record)
}

func updatePasskeyCredential(app core.App, userID string, credential *webauthn.Credential) error {
	if credential == nil {
		return errors.New("missing WebAuthn credential")
	}
	record, err := app.FindFirstRecordByFilter(
		"passkey_credentials",
		"user = {:user} && credentialId = {:credentialId}",
		dbx.Params{"user": userID, "credentialId": base64.RawURLEncoding.EncodeToString(credential.ID)},
	)
	if err != nil {
		return err
	}
	// counter 和 credentialJson 必须随库返回值一起更新；只改 publicKey 会丢掉克隆检测状态。
	setPasskeyCredentialFields(record, credential)
	return app.Save(record)
}

func setPasskeyCredentialFields(record *core.Record, credential *webauthn.Credential) {
	credentialJSON, _ := json.Marshal(credential)
	record.Set("credentialId", base64.RawURLEncoding.EncodeToString(credential.ID))
	record.Set("publicKey", base64.RawURLEncoding.EncodeToString(credential.PublicKey))
	record.Set("credentialJson", string(credentialJSON))
	record.Set("counter", int(credential.Authenticator.SignCount))
	record.Set("transports", credential.Transport)
}

func webAuthnJSONRequest(original *http.Request, body json.RawMessage) (*http.Request, error) {
	request, err := http.NewRequestWithContext(original.Context(), http.MethodPost, original.URL.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	return request, nil
}

func passkeyResponseFromRecord(record *core.Record) passkeyResponse {
	return passkeyResponse{
		ID:        record.Id,
		Name:      record.GetString("name"),
		CreatedAt: record.GetDateTime("created").String(),
	}
}
