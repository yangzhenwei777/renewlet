package main

// notification_email.go 负责 SMTP 邮件通知配置归一和发送。
//
// 架构位置：用户可在 Settings 中覆盖 SMTP；缺省时回退到部署环境变量，
// 因而这里必须同时支持请求级设置和全局配置，且在发送前完成地址/端口校验。
//
// 注意： NotifyMultipleAddresses 只影响收件人截断，不应改变配置校验；否则会让测试发送和定时发送表现不一致。
import (
	"errors"
	"net/mail"
	"os"
	"strconv"
	"strings"

	"github.com/pocketbase/pocketbase/tools/mailer"
)

// sendEmail 发送 SMTP 邮件通知。
func sendEmail(settings appSettings, message notificationMessage, locale appLocale) error {
	config, err := smtpConfigFromSettings(settings, locale)
	if err != nil {
		return err
	}
	recipients := splitList(settings.RecipientEmail)
	if !settings.NotifyMultipleAddresses && len(recipients) > 1 {
		recipients = recipients[:1]
	}
	if len(recipients) == 0 {
		return errors.New(serverText(locale, "smtp.recipientRequired"))
	}
	to := make([]mail.Address, 0, len(recipients))
	for _, recipient := range recipients {
		addr, err := mail.ParseAddress(recipient)
		if err != nil {
			return errors.New(serverFormat(locale, "smtp.recipientInvalid", map[string]interface{}{"recipient": recipient}))
		}
		to = append(to, *addr)
	}
	from, err := mail.ParseAddress(config.From)
	if err != nil {
		return errors.New(serverText(locale, "smtp.fromInvalid"))
	}
	headers := map[string]string{}
	if config.ReplyTo != "" {
		replyTo, err := mail.ParseAddress(config.ReplyTo)
		if err != nil {
			return errors.New(serverText(locale, "smtp.replyToInvalid"))
		}
		headers["Reply-To"] = replyTo.String()
	}
	client := &mailer.SMTPClient{
		Host:       config.Host,
		Port:       config.Port,
		Username:   config.Username,
		Password:   config.Password,
		TLS:        config.Secure,
		AuthMethod: mailer.SMTPAuthPlain,
	}
	if authMethod := strings.TrimSpace(os.Getenv("SMTP_AUTH_METHOD")); authMethod != "" && !hasSettingsSmtpConfig(settings) {
		client.AuthMethod = authMethod
	}
	htmlBody, err := buildEmailHTMLMessage(settings, message, locale)
	if err != nil {
		return err
	}
	if err := client.Send(&mailer.Message{
		From:    *from,
		To:      to,
		Subject: message.Title,
		HTML:    htmlBody,
		Text:    buildEmailTextBody(message),
		Headers: headers,
	}); err != nil {
		message := redactUpstreamSecrets(err.Error(), []string{config.Username, config.Password})
		return newNotificationChannelError(message, createUpstreamErrorDetails(nil, message))
	}
	return nil
}

type smtpConfig struct {
	Host     string
	Port     int
	Secure   bool
	Username string
	Password string
	From     string
	ReplyTo  string
}

func smtpConfigFromSettings(settings appSettings, locale appLocale) (smtpConfig, error) {
	if hasSettingsSmtpConfig(settings) {
		return buildSMTPConfigForLocale(
			strings.TrimSpace(settings.SMTPHost),
			strings.TrimSpace(settings.SMTPPort),
			settings.SMTPSecure,
			strings.TrimSpace(settings.SMTPUser),
			strings.TrimSpace(settings.SMTPPassword),
			strings.TrimSpace(settings.SMTPFrom),
			strings.TrimSpace(settings.SMTPReplyTo),
			locale,
		)
	}
	secure := envBool("SMTP_SECURE", envBool("SMTP_TLS", false))
	return buildSMTPConfigForLocale(
		strings.TrimSpace(os.Getenv("SMTP_HOST")),
		strings.TrimSpace(os.Getenv("SMTP_PORT")),
		secure,
		strings.TrimSpace(os.Getenv("SMTP_USER")),
		strings.TrimSpace(os.Getenv("SMTP_PASSWORD")),
		strings.TrimSpace(os.Getenv("SMTP_FROM")),
		strings.TrimSpace(os.Getenv("SMTP_REPLY_TO")),
		locale,
	)
}

// hasSettingsSmtpConfig 判断用户是否在 Settings 中覆盖了 SMTP 配置。
// 若没有覆盖，则回退到环境变量，便于自托管部署保留全局 SMTP。
func hasSettingsSmtpConfig(settings appSettings) bool {
	return strings.TrimSpace(settings.SMTPHost) != "" ||
		strings.TrimSpace(settings.SMTPPort) != "" ||
		strings.TrimSpace(settings.SMTPUser) != "" ||
		strings.TrimSpace(settings.SMTPPassword) != "" ||
		strings.TrimSpace(settings.SMTPFrom) != "" ||
		strings.TrimSpace(settings.SMTPReplyTo) != ""
}

func buildSMTPConfigForLocale(host, portRaw string, secure bool, username, password, from, replyTo string, locale appLocale) (smtpConfig, error) {
	if host == "" || portRaw == "" || from == "" {
		return smtpConfig{}, errors.New(serverText(locale, "smtp.incomplete"))
	}
	port, err := strconv.Atoi(portRaw)
	if err != nil || port <= 0 || port > 65535 {
		return smtpConfig{}, errors.New(serverText(locale, "smtp.invalidPort"))
	}
	if (username == "") != (password == "") {
		return smtpConfig{}, errors.New(serverText(locale, "smtp.usernamePasswordTogether"))
	}
	return smtpConfig{
		Host:     host,
		Port:     port,
		Secure:   secure,
		Username: username,
		Password: password,
		From:     from,
		ReplyTo:  replyTo,
	}, nil
}

func buildTextMessage(message notificationMessage) string {
	return message.Title + "\n\n" + message.Content + "\n\n" + message.Timestamp
}

func buildEmailTextBody(message notificationMessage) string {
	return message.Content + "\n\n" + message.Timestamp
}

func localizedFieldLabel(locale appLocale, key string) string {
	switch key {
	case "wechatWebhookURL":
		return serverText(locale, "service.wechatWebhookURL")
	case "barkServerURL":
		return serverText(locale, "service.barkServerURL")
	case "barkDeviceKey":
		return serverText(locale, "service.barkDeviceKey")
	case "serverchanSendKey":
		return serverText(locale, "service.serverchanSendKey")
	default:
		return key
	}
}

func requiredFieldError(locale appLocale, label string) error {
	return errors.New(serverFormat(locale, "common.requiredField", map[string]interface{}{"label": label}))
}

func requireNonEmptyLocalized(locale appLocale, label string, value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", requiredFieldError(locale, label)
	}
	return trimmed, nil
}
