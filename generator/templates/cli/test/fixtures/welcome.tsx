// React Email template of the CLI tests: plain elements, so it needs only react.
export default function Welcome({ name }: { name: string }) {
  return (
    <html lang="en">
      <body>
        <p>Hello {name}</p>
      </body>
    </html>
  );
}
