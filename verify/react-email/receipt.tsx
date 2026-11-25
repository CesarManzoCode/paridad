// React Email template of C24 (contract §5.6, D14): an image and a table of items
// with their total.
import { Body, Column, Container, Head, Heading, Html, Img, Preview, Row, Section, Text } from "@react-email/components";

interface Item {
  name: string;
  quantity: number;
  price: string;
}

interface ReceiptProps {
  orderId: string;
  logoUrl: string;
  items: Item[];
  total: string;
}

export default function Receipt({ orderId, logoUrl, items, total }: ReceiptProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Receipt for order {orderId}</Preview>
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Container style={{ padding: "24px" }}>
          <Img src={logoUrl} alt="Acme" width="120" height="40" />
          <Heading as="h2">Receipt for order {orderId}</Heading>
          <Section>
            <table width="100%" cellPadding={4} style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Item</th>
                  <th align="right">Quantity</th>
                  <th align="right">Price</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.name}>
                    <td>{item.name}</td>
                    <td align="right">{item.quantity}</td>
                    <td align="right">{item.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Row>
            <Column>
              <Text>Total</Text>
            </Column>
            <Column align="right">
              <Text>{total}</Text>
            </Column>
          </Row>
        </Container>
      </Body>
    </Html>
  );
}
