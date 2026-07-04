import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ApiSquare - Sistema de Reservas",
  description: "Bot de Telegram y panel de administración para reservas",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
