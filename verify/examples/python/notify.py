"""Example application of C20.

Uses three operations that every history version with a complete operationId has with
the same shape (emails/send, emails/get, domains/list). It never talks to the real API:
without RESEND_BASE_URL it refuses to build a client.
"""

from __future__ import annotations

import os

from paridad_resend import Resend


def client() -> Resend:
    base_url = os.environ.get("RESEND_BASE_URL", "")
    if base_url == "":
        raise RuntimeError("RESEND_BASE_URL must point to the capture server")
    return Resend(os.environ.get("RESEND_API_KEY", "re_paridad_test_9f8e7d6c5b4a39281706"), base_url=base_url)


def send_welcome(resend: Resend, to: str) -> object:
    sent = resend.emails.send({"from": "Acme <onboarding@resend.dev>", "to": [to], "subject": "Welcome", "html": "<p>Welcome!</p>"})
    return sent.get("id")


def email_id(resend: Resend, id: str) -> object:
    return resend.emails.get(id).get("id")


def domain_count(resend: Resend) -> int:
    return len(resend.domains.list().get("data") or [])
