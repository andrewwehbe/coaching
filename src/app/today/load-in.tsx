'use client';

import { useRouter } from 'next/navigation';
import { useState, type CSSProperties } from 'react';
import './load-in.css';

type Day = {
  dayId: string;
  dayIndex: number;
  label: string;
  status: 'done' | 'upcoming' | 'in_progress' | 'missed';
  workoutId?: string | null;
};

type Suggested = {
  dayId: string;
  label: string;
  workoutId?: string | null;
} | null;

const SLEEVE_TOP = 8;
const SLEEVE_BOTTOM = 600;
const GAP = 8;
const BASE_DELAY = 500;
const STAGGER = 600;
const DROP_DURATION = 850;
const BUTTON_BUFFER = 200;

function shortLabel(label: string): string {
  // Strip "Day N — " or "Day N - " prefix the way /today's main page does.
  const stripped = label.replace(/^Day\s*\d+\s*[—-]\s*/i, '').trim();
  return stripped || label;
}

export function LoadInView({
  greetingName,
  days,
  suggested,
  threeInARowWarning,
  isDeloadWeek,
  rightControls,
}: {
  greetingName: string;
  days: Day[];
  suggested: Suggested;
  threeInARowWarning?: boolean;
  isDeloadWeek?: boolean;
  rightControls?: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmThree, setConfirmThree] = useState(false);

  const sorted = [...days].sort((a, b) => a.dayIndex - b.dayIndex);
  const N = sorted.length;
  const plateHeight =
    N > 0 ? Math.floor((SLEEVE_BOTTOM - SLEEVE_TOP - (N - 1) * GAP) / N) : 140;

  const currentIndex = suggested
    ? sorted.findIndex((d) => d.dayId === suggested.dayId)
    : -1;

  // Stack from top (newest = Day N) down to bottom (oldest = Day 1).
  // Animation order is chronological — Day 1 lands first.
  const positioned = sorted.map((d, chronoIndex) => {
    const stackPos = N - 1 - chronoIndex; // 0 = bottom, N-1 = top
    const yOffset = SLEEVE_TOP + stackPos * (plateHeight + GAP);
    const isCurrent = chronoIndex === currentIndex;
    const delay = BASE_DELAY + chronoIndex * STAGGER;
    const impactTime = delay + DROP_DURATION;
    return { day: d, yOffset, isCurrent, chronoIndex, delay, impactTime };
  });

  const impactTimes = positioned.map((p) => p.impactTime);
  const lastImpact = impactTimes.length > 0 ? Math.max(...impactTimes) : 0;
  const currentImpact =
    positioned.find((p) => p.isCurrent)?.impactTime ?? lastImpact;

  const shakeAnim =
    impactTimes.map((t) => `loadinShake 380ms ${t}ms ease-out`).join(', ') ||
    'none';
  const flashAnim =
    impactTimes
      .map((t) => `loadinImpactFlash 600ms ${t}ms ease-out`)
      .join(', ') || 'none';
  const buttonDelay = lastImpact + BUTTON_BUFFER;

  async function startNow() {
    if (!suggested || busy) return;
    setBusy(true);
    try {
      if (suggested.workoutId) {
        router.push(`/workout/${suggested.workoutId}`);
        return;
      }
      const res = await fetch('/api/client/workout/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dayId: suggested.dayId }),
      });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      const { workoutId } = await res.json();
      router.push(`/workout/${workoutId}`);
    } catch {
      setBusy(false);
    }
  }

  function start() {
    if (!suggested || busy) return;
    if (threeInARowWarning && !suggested.workoutId) {
      setConfirmThree(true);
      return;
    }
    void startNow();
  }

  const buttonLabel = suggested
    ? `Start ${shortLabel(suggested.label) || `Day ${currentIndex + 1}`}`
    : 'All done this week';
  const startedAlready = !!suggested?.workoutId;

  const stageStyle: CSSProperties = {
    animation: shakeAnim,
    // CSS custom property for the floor glow delay
    ['--floor-glow-delay' as string]: `${currentImpact}ms`,
  };

  return (
    <div className="loadin-screen">
      <div className="loadin-top">
        <div className="loadin-masthead">
          <div>
            <p className="loadin-eyebrow">Hey,</p>
            <p className="loadin-greeting">{greetingName}</p>
          </div>
          {rightControls && <div className="loadin-controls">{rightControls}</div>}
        </div>
        <div className="loadin-week">
          <p>{isDeloadWeek ? 'Deload week' : 'This week'}</p>
        </div>
      </div>

      {isDeloadWeek && (
        <div className="loadin-warn" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
          <p>Deload · drop ~25% load, keep reps the same, stop ~3 reps shy of failure</p>
        </div>
      )}

      {threeInARowWarning && (
        <div className="loadin-warn">
          <p>2 days in a row · a third isn&rsquo;t recommended</p>
        </div>
      )}

      <div className="loadin-stage" style={stageStyle}>
        <div className="loadin-flash" style={{ animation: flashAnim }} />
        <svg
          viewBox="0 0 400 700"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMax meet"
        >
          <defs>
            <linearGradient id="loadin-sleeve" x1="0%" y1="50%" x2="100%" y2="50%">
              <stop offset="0%" stopColor="#0a0a0a" />
              <stop offset="6%" stopColor="#1c1c1a" />
              <stop offset="14%" stopColor="#3d3d3a" />
              <stop offset="22%" stopColor="#666460" />
              <stop offset="32%" stopColor="#8e8c87" />
              <stop offset="42%" stopColor="#b6b3ac" />
              <stop offset="50%" stopColor="#dad6cd" />
              <stop offset="58%" stopColor="#bcb9b1" />
              <stop offset="68%" stopColor="#8e8c87" />
              <stop offset="78%" stopColor="#65635f" />
              <stop offset="86%" stopColor="#3a3936" />
              <stop offset="94%" stopColor="#1c1b1a" />
              <stop offset="100%" stopColor="#0a0a0a" />
            </linearGradient>
            <linearGradient id="loadin-shaft" x1="0%" y1="50%" x2="100%" y2="50%">
              <stop offset="0%" stopColor="#0a0a0a" />
              <stop offset="14%" stopColor="#3a3a38" />
              <stop offset="32%" stopColor="#7e7c76" />
              <stop offset="46%" stopColor="#b6b3ac" />
              <stop offset="50%" stopColor="#cbc7be" />
              <stop offset="54%" stopColor="#b8b5ae" />
              <stop offset="68%" stopColor="#7e7c76" />
              <stop offset="86%" stopColor="#2a2a28" />
              <stop offset="100%" stopColor="#0a0a0a" />
            </linearGradient>
            <linearGradient id="loadin-collar" x1="0%" y1="50%" x2="100%" y2="50%">
              <stop offset="0%" stopColor="#0c0c0a" />
              <stop offset="14%" stopColor="#404040" />
              <stop offset="34%" stopColor="#8c8a83" />
              <stop offset="50%" stopColor="#cdc9c0" />
              <stop offset="66%" stopColor="#8c8a83" />
              <stop offset="86%" stopColor="#2c2c2a" />
              <stop offset="100%" stopColor="#0a0a0a" />
            </linearGradient>
            <filter id="loadin-brushed" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.025 1.4"
                numOctaves={2}
                seed={6}
              />
              <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.34 0" />
            </filter>
          </defs>

          {/* Bar — minimal: end cap, hidden sleeve, collar, shaft stub */}
          <rect x={172} y={0} width={56} height={6} rx={1} fill="url(#loadin-sleeve)" />
          <rect x={172} y={0} width={56} height={2} fill="rgba(255,255,255,0.45)" />
          <rect x={178} y={6} width={44} height={595} fill="url(#loadin-sleeve)" />
          <rect
            x={178}
            y={6}
            width={44}
            height={595}
            filter="url(#loadin-brushed)"
            opacity={0.5}
          />
          <rect x={198.5} y={6} width={2} height={595} fill="rgba(255,255,255,0.55)" />
          <rect x={160} y={601} width={80} height={20} fill="url(#loadin-collar)" />
          <rect
            x={160}
            y={601}
            width={80}
            height={20}
            filter="url(#loadin-brushed)"
            opacity={0.28}
          />
          <rect x={160} y={601} width={80} height={2} fill="rgba(0,0,0,0.85)" />
          <rect x={160} y={619} width={80} height={2} fill="rgba(0,0,0,0.6)" />
          <rect x={160} y={607} width={80} height={2} fill="rgba(255,255,255,0.42)" />
          <rect x={186} y={621} width={28} height={79} fill="url(#loadin-shaft)" />
          <rect
            x={186}
            y={621}
            width={28}
            height={79}
            filter="url(#loadin-brushed)"
            opacity={0.3}
          />
          <rect x={198.5} y={621} width={2} height={79} fill="rgba(255,255,255,0.55)" />

          {/* Plates — chronological, Day 1 lands first */}
          {positioned.map(({ day, yOffset, isCurrent, delay }) => {
            const isDone = day.status === 'done';
            const isInProgress = day.status === 'in_progress';
            const isMissed = day.status === 'missed';
            const eyebrowFill = isCurrent ? 'var(--primary-hi)' : 'var(--faint)';
            const strokeColor = isCurrent ? 'var(--primary)' : 'var(--border)';
            const strokeWidth = isCurrent ? 2 : 1;
            const label = shortLabel(day.label);
            return (
              <g
                key={day.dayId}
                className="loadin-plate"
                style={{ animationDelay: `${delay}ms` }}
              >
                <g transform={`translate(0 ${yOffset})`}>
                  <rect
                    x={20}
                    y={0}
                    width={360}
                    height={plateHeight}
                    rx={14}
                    fill="#000"
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                  />
                  <text
                    x={40}
                    y={plateHeight / 2 - 10}
                    fontFamily="ui-sans-serif, system-ui, sans-serif"
                    fontSize={11}
                    letterSpacing={2.6}
                    fill={eyebrowFill}
                  >
                    {`DAY ${day.dayIndex}`}
                  </text>
                  <text
                    x={40}
                    y={plateHeight / 2 + 24}
                    fontFamily="ui-sans-serif, system-ui, sans-serif"
                    fontWeight={500}
                    fontSize={22}
                    fill="var(--text)"
                  >
                    {label}
                  </text>
                  <StatusChip
                    cx={360}
                    cy={plateHeight / 2}
                    label={
                      isDone
                        ? 'DONE'
                        : isInProgress
                          ? 'IN PROGRESS'
                          : isMissed
                            ? 'MISSED'
                            : 'UPCOMING'
                    }
                    tone={
                      isDone
                        ? 'done'
                        : isInProgress
                          ? 'progress'
                          : isMissed
                            ? 'missed'
                            : 'upcoming'
                    }
                  />
                </g>
              </g>
            );
          })}
        </svg>
        <button
          type="button"
          className="loadin-start"
          style={{ animationDelay: `${buttonDelay}ms` }}
          onClick={start}
          disabled={!suggested || busy}
        >
          {busy
            ? 'Starting…'
            : !suggested
              ? 'All done this week'
              : startedAlready
                ? `Resume Day ${currentIndex + 1}`
                : buttonLabel}
          {suggested && !busy && (
            <span className="arrow" aria-hidden="true">
              →
            </span>
          )}
        </button>
      </div>

      {confirmThree && (
        <div
          className="fixed inset-0 z-50 bg-bg/85 backdrop-blur flex items-end sm:items-center justify-center p-4"
          style={{ paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
          onClick={() => setConfirmThree(false)}
        >
          <div
            className="w-full max-w-sm bg-surface rounded-2xl border border-border p-5 space-y-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <p className="text-[10px] uppercase tracking-[0.22em] text-warn mb-1.5">
                Heads up
              </p>
              <h3 className="text-lg font-semibold leading-tight">
                Three days in a row isn&rsquo;t recommended.
              </h3>
              <p className="mt-2 text-sm text-muted">
                You&rsquo;ve trained the last 2 days. Recovery is part of the program — but if
                you&rsquo;re feeling fresh, you can push through.
              </p>
            </div>
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setConfirmThree(false);
                  void startNow();
                }}
                className="w-full h-11 rounded-xl bg-primary hover:bg-primary-hi text-bg text-sm font-semibold transition-colors"
              >
                Start anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirmThree(false)}
                className="w-full h-11 rounded-xl border border-border text-muted hover:bg-surface-2 hover:text-text text-sm font-medium transition-colors"
              >
                Rest today
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusChip({
  cx,
  cy,
  label,
  tone,
}: {
  cx: number;
  cy: number;
  label: string;
  tone: 'done' | 'progress' | 'missed' | 'upcoming';
}) {
  const palette =
    tone === 'done'
      ? { fill: 'rgba(34,197,94,0.15)', stroke: 'rgba(34,197,94,0.3)', text: 'var(--primary-hi)' }
      : tone === 'progress'
        ? { fill: 'rgba(125,211,252,0.10)', stroke: 'rgba(125,211,252,0.3)', text: 'var(--accent)' }
        : tone === 'missed'
          ? { fill: 'rgba(251,191,36,0.10)', stroke: 'rgba(251,191,36,0.3)', text: 'var(--warn)' }
          : { fill: 'rgba(18,26,28,0.6)', stroke: 'var(--border)', text: 'var(--muted)' };
  const width = Math.max(58, label.length * 6.5 + 18);
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <rect
        x={-width}
        y={-14}
        width={width}
        height={22}
        rx={11}
        fill={palette.fill}
        stroke={palette.stroke}
        strokeWidth={0.8}
      />
      <text
        x={-width / 2}
        y={1}
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize={9}
        letterSpacing={1.6}
        fill={palette.text}
      >
        {label}
      </text>
    </g>
  );
}
