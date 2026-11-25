package notify

import (
	"context"
	"testing"
)

const emailID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"

func TestSendWelcome(t *testing.T) {
	client, err := NewClient()
	if err != nil {
		t.Fatal(err)
	}
	id, err := SendWelcome(context.Background(), client, "delivered@resend.dev")
	if err != nil {
		t.Fatal(err)
	}
	if id == nil {
		t.Fatal("the sent email has no id")
	}
}

func TestEmailID(t *testing.T) {
	client, err := NewClient()
	if err != nil {
		t.Fatal(err)
	}
	id, err := EmailID(context.Background(), client, emailID)
	if err != nil {
		t.Fatal(err)
	}
	if id == nil {
		t.Fatal("the email has no id")
	}
}

func TestDomainCount(t *testing.T) {
	client, err := NewClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DomainCount(context.Background(), client); err != nil {
		t.Fatal(err)
	}
}
