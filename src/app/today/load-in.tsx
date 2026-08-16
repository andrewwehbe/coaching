'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Button, Sheet } from '@/components/ui';
import './load-in.css';

type CheckInPill = {
  due: boolean;
  period: 'day' | 'week';
  done: number;
  target: number;
};

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
// Compressed timeline: for a 5-day program the last plate lands at
// ~980ms and the CTA is tappable at ~1.1s. The old choreography
// (500 + 600/plate + 850 drop) parked the CTA ~3.9s after paint,
// every single visit.
const BASE_DELAY = 120;
const STAGGER = 110;
const DROP_DURATION = 420;
const BUTTON_BUFFER = 120;

// SVG canvas the barbell art is drawn in; the DOM overlay maps its
// coordinates through the measured content box (see below).
const VIEW_W = 400;
const VIEW_H = 700;

function shortLabel(label: string): string {
  // Strip "Day N — " or "Day N - " prefix the way /today's main page does.
  const stripped = label.replace(/^Day\s*\d+\s*[—-]\s*/i, '').trim();
  return stripped || label;
}

const STATUS_LABEL = {
  done: 'Done',
  in_progress: 'In progress',
  missed: 'Missed',
  upcoming: 'Upcoming',
} as const;

export function LoadInView({
  greetingName,
  days,
  suggested,
  threeInARowWarning,
  isDeloadWeek,
  checkIn,
  rightControls,
}: {
  greetingName: string;
  days: Day[];
  suggested: Suggested;
  threeInARowWarning?: boolean;
  isDeloadWeek?: boolean;
  checkIn?: CheckInPill | null;
  rightControls?: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmThree, setConfirmThree] = useState(false);
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);

  // Same-day revisits skip the choreography entirely — the animation is a
  // greeting, not a toll. (Reduced-motion is handled by the global CSS
  // guard, which zeroes durations AND delays.)
  const [instant, setInstant] = useState(false);
  useLayoutEffect(() => {
    const key = `coaching:loadin-seen:${new Date().toDateString()}`;
    try {
      if (sessionStorage.getItem(key)) setInstant(true);
      sessionStorage.setItem(key, '1');
    } catch {
      /* private mode — animate every time */
    }
  }, []);

  // The svg uses preserveAspectRatio="xMidYMax meet", so its 400×700
  // canvas is scaled and letterboxed inside the stage. Measure the stage
  // and derive the content box so DOM overlays land exactly on the
  // SVG-drawn plates.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ scale: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      const scale = Math.min(w / VIEW_W, h / VIEW_H);
      setBox({ scale, left: (w - VIEW_W * scale) / 2, top: h - VIEW_H * scale });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sorted = [...days].sort((a, b) => a.dayIndex - b.dayIndex);
  const N = sorted.length;
  const plateHeight =
    N > 0 ? Math.floor((SLEEVE_BOTTOM - SLEEVE_TOP - (N - 1) * GAP) / N) : 140;

  // Active day = explicit user pick (any non-done plate) ?? suggested default.
  const fallbackActive: Day | null = suggested
    ? sorted.find((d) => d.dayId === suggested.dayId) ?? null
    : null;
  const selectedActive: Day | null = selectedDayId
    ? sorted.find((d) => d.dayId === selectedDayId && d.status !== 'done') ?? null
    : null;
  const activeDay: Day | null = selectedActive ?? fallbackActive;
  const currentIndex = activeDay
    ? sorted.findIndex((d) => d.dayId === activeDay.dayId)
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
    if (!activeDay || busy) return;
    const resuming =
      !!activeDay.workoutId && activeDay.status === 'in_progress';
    setBusy(true);
    try {
      if (resuming) {
        router.push(`/workout/${activeDay.workoutId}`);
        return;
      }
      const res = await fetch('/api/client/workout/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dayId: activeDay.dayId }),
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
    if (!activeDay || busy) return;
    const resuming =
      !!activeDay.workoutId && activeDay.status === 'in_progress';
    if (threeInARowWarning && !resuming) {
      setConfirmThree(true);
      return;
    }
    void startNow();
  }

  const buttonLabel = activeDay
    ? `Start Day ${currentIndex + 1}`
    : 'All done this week';
  const startedAlready =
    !!activeDay?.workoutId && activeDay?.status === 'in_progress';

  const stageStyle: CSSProperties = {
    animation: shakeAnim,
    // CSS custom property for the floor glow delay
    ['--floor-glow-delay' as string]: `${currentImpact}ms`,
  };

  return (
    <div className={`loadin-screen${instant ? ' loadin-noanim' : ''}`}>
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

      {checkIn && <CheckInBanner pill={checkIn} />}

      <div className="loadin-stage" style={stageStyle} ref={stageRef}>
        <div className="loadin-flash" style={{ animation: flashAnim }} />
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMax meet"
          aria-hidden="true"
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

          {/* Plate metal — art only. Labels, chips, and taps live in the
              DOM overlay below so they're real, focusable controls. */}
          {positioned.map(({ day, yOffset, isCurrent, delay }) => (
            <g
              key={day.dayId}
              className="loadin-plate"
              style={{ animationDelay: `${delay}ms` }}
            >
              <rect
                x={20}
                y={yOffset}
                width={360}
                height={plateHeight}
                rx={14}
                fill="#000"
                stroke={isCurrent ? 'var(--primary)' : 'var(--border)'}
                strokeWidth={isCurrent ? 2 : 1}
              />
            </g>
          ))}
        </svg>

        {/* Interactive layer — one absolutely-positioned block per plate,
            mapped through the measured SVG content box. The old version
            drew day text and a ~19px-tall "VIEW" affordance as SVG with
            no focus, no wrapping, and sub-44px targets. */}
        {box && (
          <div className="loadin-overlay">
            {positioned.map(({ day, yOffset, isCurrent, impactTime }) => {
              const label = shortLabel(day.label);
              const statusLabel = STATUS_LABEL[day.status];
              const style: CSSProperties = {
                top: box.top + yOffset * box.scale,
                left: box.left + 20 * box.scale,
                width: 360 * box.scale,
                height: plateHeight * box.scale,
                ['--reveal-delay' as string]: `${impactTime}ms`,
              };
              return (
                <div key={day.dayId} className="loadin-plate-content" style={style}>
                  {day.status !== 'done' && (
                    <button
                      type="button"
                      className="loadin-plate-select"
                      aria-pressed={isCurrent}
                      aria-label={`Choose Day ${day.dayIndex} — ${label} (${statusLabel})`}
                      onClick={() => setSelectedDayId(day.dayId)}
                    />
                  )}
                  <div className="loadin-plate-text">
                    <p
                      className="loadin-plate-eyebrow"
                      style={{ color: isCurrent ? 'var(--primary-hi)' : 'var(--faint)' }}
                    >
                      Day {day.dayIndex}
                    </p>
                    <p className="loadin-plate-label">{label}</p>
                  </div>
                  <span className={`loadin-chip loadin-chip-${day.status}`}>
                    {statusLabel}
                  </span>
                  <Link
                    href={`/day/${day.dayId}`}
                    className="loadin-view"
                    aria-label={`View Day ${day.dayIndex} — ${label}`}
                  >
                    <span>View →</span>
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className="loadin-start"
          style={{ animationDelay: `${buttonDelay}ms` }}
          onClick={start}
          disabled={!activeDay || busy}
        >
          {busy
            ? 'Starting…'
            : !activeDay
              ? 'All done this week'
              : startedAlready
                ? `Resume Day ${currentIndex + 1}`
                : buttonLabel}
          {activeDay && !busy && (
            <span className="arrow" aria-hidden="true">
              →
            </span>
          )}
        </button>
      </div>

      {confirmThree && (
        <Sheet
          title="Three days in a row isn't recommended."
          subtitle="You've trained the last 2 days. Recovery is part of the program — but if you're feeling fresh, you can push through."
          onClose={() => setConfirmThree(false)}
        >
          <div className="space-y-2 pt-1">
            <Button
              variant="primary"
              className="w-full"
              onClick={() => {
                setConfirmThree(false);
                void startNow();
              }}
            >
              Start anyway
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setConfirmThree(false)}
            >
              Rest today
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function CheckInBanner({ pill }: { pill: CheckInPill }) {
  const periodLabel = pill.period === 'day' ? 'today' : 'this week';
  if (!pill.due) {
    const doneLabel =
      pill.target > 1
        ? `Check-in ${pill.done}/${pill.target} ${periodLabel}`
        : `Checked in ${periodLabel}`;
    return (
      <Link href="/check-in" className="loadin-checkin loadin-checkin-done">
        <span aria-hidden="true">✓</span>
        <span>{doneLabel}</span>
      </Link>
    );
  }
  const dueLabel =
    pill.target > 1
      ? `Check-in due · ${pill.done}/${pill.target} ${periodLabel}`
      : `Check-in due ${periodLabel}`;
  return (
    <Link href="/check-in" className="loadin-checkin loadin-checkin-due">
      <span>{dueLabel}</span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}
