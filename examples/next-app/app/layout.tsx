import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "groundwork example",
  description: "A Next.js app that uses every groundwork module.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "48rem" }}>
        {children}
      </body>
    </html>
  );
}
