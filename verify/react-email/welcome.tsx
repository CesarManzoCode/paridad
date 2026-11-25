// React Email template of C24 (contract §5.6, D14): text, a button and a link.
import { Body, Button, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

interface WelcomeProps {
  name: string;
  dashboardUrl: string;
}

export default function Welcome({ name, dashboardUrl }: WelcomeProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Welcome to Acme, {name}</Preview>
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Container style={{ padding: "24px" }}>
          <Heading as="h1">Welcome, {name}</Heading>
          <Text>Your account is ready. Open the dashboard to send your first email.</Text>
          <Button href={dashboardUrl} style={{ backgroundColor: "#000000", color: "#ffffff", padding: "12px 20px" }}>
            Open the dashboard
          </Button>
          <Text>
            Questions? Read the <Link href="https://example.com/docs">documentation</Link>.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
