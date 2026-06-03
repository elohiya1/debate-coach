import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Interview Coach',
  description: 'AI-powered mock behavioral interview coach',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
