// Package notify is the example application of C20: it uses three operations that every
// history version with a complete operationId has with the same shape (emails/send,
// emails/get, domains/list). It never talks to the real API: without RESEND_BASE_URL it
// refuses to build a client.
package notify

import (
	"context"
	"errors"
	"os"

	resend "github.com/CesarManzoCode/paridad/sdks/go"
)

// NewClient builds a client against RESEND_BASE_URL.
func NewClient() (*resend.Client, error) {
	baseURL := os.Getenv("RESEND_BASE_URL")
	if baseURL == "" {
		return nil, errors.New("RESEND_BASE_URL must point to the capture server")
	}
	key := os.Getenv("RESEND_API_KEY")
	if key == "" {
		key = "re_paridad_test_9f8e7d6c5b4a39281706"
	}
	return resend.NewClient(resend.WithAPIKey(key), resend.WithBaseURL(baseURL))
}

// SendWelcome sends a welcome email and returns its id.
func SendWelcome(ctx context.Context, client *resend.Client, to string) (*string, error) {
	html := "<p>Welcome!</p>"
	sent, err := client.Emails.Send(ctx, &resend.SendEmailRequest{From: "Acme <onboarding@resend.dev>", To: []string{to}, Subject: "Welcome", HTML: &html})
	if err != nil {
		return nil, err
	}
	return sent.ID, nil
}

// EmailID reads an email and returns its id.
func EmailID(ctx context.Context, client *resend.Client, id string) (*string, error) {
	email, err := client.Emails.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return email.ID, nil
}

// DomainCount returns the number of domains of the first page.
func DomainCount(ctx context.Context, client *resend.Client) (int, error) {
	page, err := client.Domains.List(ctx, nil)
	if err != nil {
		return 0, err
	}
	return len(page.Data), nil
}
