// Example application of C20: uses three operations that every history version with a
// complete operationId has with the same shape (emails/send, emails/get, domains/list).
// It never talks to the real API: without RESEND_BASE_URL it refuses to build a client.
import { Resend } from "paridad-resend";

export function client(): Resend {
  const baseUrl = process.env["RESEND_BASE_URL"];
  if (baseUrl === undefined || baseUrl === "") throw new Error("RESEND_BASE_URL must point to the capture server");
  return new Resend(process.env["RESEND_API_KEY"] ?? "re_paridad_test_9f8e7d6c5b4a39281706", { baseUrl });
}

export async function sendWelcome(resend: Resend, to: string): Promise<string | undefined> {
  const { data, error } = await resend.emails.send({ from: "Acme <onboarding@resend.dev>", to: [to], subject: "Welcome", html: "<p>Welcome!</p>" });
  if (error !== null) throw error;
  return data.id;
}

export async function emailId(resend: Resend, id: string): Promise<string | undefined> {
  const { data, error } = await resend.emails.get(id);
  if (error !== null) throw error;
  return data.id;
}

export async function domainCount(resend: Resend): Promise<number> {
  const { data, error } = await resend.domains.list();
  if (error !== null) throw error;
  return (data.data ?? []).length;
}
