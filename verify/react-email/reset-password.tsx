// React Email template of C24 (contract §5.6, D14): a reset link with an expiry and a
// fallback link in plain text.
import { Body, Button, Container, Head, Hr, Html, Link, Preview, Text } from "@react-email/components";

interface ResetPasswordProps {
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export default function ResetPassword({ name, resetUrl, expiresInMinutes }: ResetPasswordProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Reset your Acme password</Preview>
      <Body style={{ backgroundColor: "#f6f6f6", fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Container style={{ backgroundColor: "#ffffff", padding: "24px" }}>
          <Text>Hi {name},</Text>
          <Text>Someone asked to reset the password of your account. The link expires in {expiresInMinutes} minutes.</Text>
          <Button href={resetUrl} style={{ backgroundColor: "#2754c5", color: "#ffffff", padding: "12px 20px" }}>
            Reset password
          </Button>
          <Hr />
          <Text>
            If the button does not work, open <Link href={resetUrl}>{resetUrl}</Link>. If you did not ask for it, ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
