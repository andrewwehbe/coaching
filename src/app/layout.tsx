import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { SwRegister } from '@/components/sw-register';
import { IosInstallHint } from '@/components/ios-install-hint';
import { Toaster } from '@/components/ui';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Coaching',
  description: 'Workout tracking',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Coaching',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/icon-192.png',
  },
};

export const viewport: Viewport = {
  // Match --bg exactly so the iOS home-indicator / Android nav bar blends
  // into the page rather than showing as a contrasting band.
  themeColor: '#06090a',
  width: 'device-width',
  initialScale: 1,
  // Pinch zoom stays enabled (WCAG 1.4.4). The old maximumScale:1 +
  // userScalable:false blocked it; the 16px input floor in globals.css is
  // what actually prevents iOS focus-zoom, so nothing regresses.
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg text-text flex flex-col font-sans">
        {children}
        <SwRegister />
        <IosInstallHint />
        <Toaster />
      </body>
    </html>
  );
}
