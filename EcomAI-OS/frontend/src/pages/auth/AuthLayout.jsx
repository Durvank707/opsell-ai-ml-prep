import React from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../../components/layout/Logo';
import { cn } from '../../lib/utils';

export default function AuthLayout({ children }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Left brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-slate-900 lg:flex">
        <div className="absolute inset-0 opacity-[0.16]" aria-hidden>
          <InventoryViz />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-slate-900/40 via-transparent to-slate-900/60" aria-hidden />
        <div className="relative z-10 p-10">
          <div className="flex items-center gap-3">
            <Logo light />
            <span className="text-lg font-extrabold text-white">
              EcomAI<span className="text-brand-400">-OS</span>
            </span>
          </div>
        </div>
        <div className="relative z-10 p-10">
          <h1 className="max-w-md text-[28px] font-extrabold leading-tight text-white">
            AI-powered inventory intelligence for smarter stock decisions.
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-400">
            Understand your inventory, predict demand, and act before problems
            happen — with demand forecasts, recommendations and policy
            simulation built for e-commerce teams.
          </p>
          <div className="mt-8 flex gap-8">
            <div>
              <p className="text-2xl font-extrabold text-white">99%+</p>
              <p className="text-xs text-slate-400">Service level targets</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold text-white">12.4L</p>
              <p className="text-xs text-slate-400">Portfolio value managed</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold text-white">245</p>
              <p className="text-xs text-slate-400">SKUs in one workspace</p>
            </div>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex w-full flex-col lg:w-1/2">
        <div className="flex items-center justify-between p-5 lg:hidden">
          <Link to="/" className="flex items-center gap-2.5">
            <Logo size="sm" />
            <span className="text-base font-extrabold text-slate-900">
              EcomAI<span className="text-brand-600">-OS</span>
            </span>
          </Link>
        </div>
        <div className={cn('flex flex-1 items-center justify-center px-4 pb-12 sm:px-8')}>
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}

function InventoryViz() {
  // Abstract inventory/demand visualization — decorative only.
  const bars = [34, 52, 41, 63, 48, 72, 58, 84, 66, 91, 74, 96];
  const line = [40, 46, 44, 55, 58, 64, 62, 74, 80, 78, 88, 92];
  const max = 100;
  return (
    <svg viewBox="0 0 600 400" className="h-full w-full" preserveAspectRatio="xMidYMid meet">
      <text x="40" y="46" fill="#a5b4fc" fontSize="14" fontWeight="700">Inventory Health</text>
      <rect x="40" y="70" width="150" height="8" rx="4" fill="#10b981" />
      <rect x="205" y="70" width="120" height="8" rx="4" fill="#f59e0b" />
      <rect x="340" y="70" width="90" height="8" rx="4" fill="#f43f5e" />
      <text x="40" y="110" fill="#94a3b8" fontSize="11">Demand vs Forecast</text>
      {bars.map((h, i) => (
        <rect
          key={i}
          x={40 + i * 44}
          y={180 - (h / max) * 140}
          width="30"
          height={(h / max) * 140}
          rx="4"
          fill={i < 6 ? '#334155' : '#4f46e5'}
          opacity={i < 6 ? 0.85 : 0.9}
        />
      ))}
      <polyline
        points={line.map((v, i) => `${45 + i * 44},${200 - (v / max) * 150}`).join(' ')}
        fill="none"
        stroke="#a5b4fc"
        strokeWidth="2.5"
        strokeDasharray="5 4"
      />
      <circle cx="45" cy={200 - (line[0] / max) * 150} r="4" fill="#c7d2fe" />
      <text x="40" y="250" fill="#94a3b8" fontSize="11">Reorder simulation</text>
      <rect x="40" y="265" width="520" height="90" rx="12" fill="#1e293b" stroke="#334155" />
      <polyline
        points={[55, 295, 90, 282, 130, 292, 170, 275, 215, 285, 260, 270, 310, 280, 355, 265, 400, 278, 445, 260, 490, 272, 535, 255]
          .map((v, i, arr) => (i % 2 === 0 ? `${v},${arr[i + 1]}` : ''))
          .filter(Boolean)
          .join(' ')}
        fill="none"
        stroke="#34d399"
        strokeWidth="2"
      />
      <text x="40" y="380" fill="#64748b" fontSize="11">Serious, data-driven decisions — without the guesswork.</text>
    </svg>
  );
}