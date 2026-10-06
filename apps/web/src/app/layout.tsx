import './globals.css';
import React from 'react';

export const metadata = {
  title: 'Channel Integration Hub | Ops Dashboard',
  description: 'Operational visibility, dead-letter sync queue and partner health',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0b0f19] text-slate-100 antialiased">
        <header className="border-b border-slate-800 bg-[#111827]/80 backdrop-blur sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
            <h1 className="font-semibold text-lg tracking-wide text-white">Channel Integration Hub</h1>
            <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">Production Ops</span>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}