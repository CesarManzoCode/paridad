from __future__ import annotations

from notify import client, domain_count, email_id, send_welcome

EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"


def test_sends_a_welcome_email() -> None:
    assert isinstance(send_welcome(client(), "delivered@resend.dev"), str)


def test_reads_an_email() -> None:
    assert isinstance(email_id(client(), EMAIL_ID), str)


def test_counts_the_domains_of_a_page() -> None:
    assert domain_count(client()) >= 0
