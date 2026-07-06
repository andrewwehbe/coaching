-- Manual "set as best" override.
--
-- The workout cue normally anchors to the current-block best (block-best.ts):
-- cue = blockBest ?? best_efforts. But a client can also pin a specific
-- historical set as their best via /api/client/exercise/set-best — e.g. to
-- correct a stale peak or a mis-entered weight. A pin is an EXPLICIT override
-- and must win over the computed block-best, otherwise the pin would be
-- silently ignored whenever the current block has any data.
--
-- This flag distinguishes a deliberately-pinned row from the auto-maintained
-- all-time PR. The cue reads: pinned ? best_efforts : (blockBest ?? best_efforts).
--
-- Auto PR updates (upsertBestEffortFromSet) write pinned=false, so a genuine
-- new PR that beats the pinned weight naturally reclaims the row.
alter table best_efforts
  add column if not exists pinned boolean not null default false;
