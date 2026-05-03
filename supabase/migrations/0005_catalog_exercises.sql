-- Curated exercise catalog used to suggest non-redundant variations
-- when a swap_candidate or pain finding fires. Each entry maps to a
-- group_key — alternatives within the same group_key are considered
-- substitutes for each other.
create table catalog_exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  group_key text not null,
  created_at timestamptz not null default now()
);
create index catalog_group_idx on catalog_exercises (group_key);

insert into catalog_exercises (name, group_key) values
-- Chest
('Flat pec deck','chest'),
('Incline DB press','chest'),
('Flat DB press','chest'),
('High-to-low cable fly','chest'),
('Low-to-high cable fly','chest'),
('Upper chest machine press','chest'),
('Flat chest machine press','chest'),
('Low chest machine press','chest'),
('Leaning dips','chest'),
('Flat bench press','chest'),
('Incline bench press','chest'),
('Incline Smith bench press','chest'),
('Flat Smith bench press','chest'),
-- Side delts
('DB lateral raise','side_delts'),
('Cable lateral raise (wrist cuff)','side_delts'),
-- Shoulder press
('Machine shoulder press','shoulder_press'),
('DB shoulder press','shoulder_press'),
('Smith seated shoulder press','shoulder_press'),
-- Rear delts
('Rear delt fly (machine)','rear_delts'),
('Face pull','rear_delts'),
('Single-arm cable rear delt fly','rear_delts'),
-- Traps
('Horizontal shrug','traps'),
('Vertical shrug','traps'),
-- Back rows
('T-bar row, elbows flared','back_rows'),
('T-bar row, elbows tucked','back_rows'),
('Chest-supported row, elbows flared','back_rows'),
('Chest-supported row, elbows tucked','back_rows'),
('Low row, elbows tucked','back_rows'),
('High-to-low row, elbows tucked','back_rows'),
('Close-grip cable row','back_rows'),
('Chest-supported DB row','back_rows'),
('Single-arm seated row','back_rows'),
('Wide-grip seated row','back_rows'),
-- Back lats
('Wide-grip lat pulldown','back_lats'),
('Close-grip lat pulldown','back_lats'),
('Underhand lat pulldown','back_lats'),
('Single-arm lat pulldown','back_lats'),
('Pullover machine','back_lats'),
('Cable lat pullover','back_lats'),
('Single-arm lat pullover','back_lats'),
-- Abs
('Ab curl machine','abs'),
('Leg raises (with bracing)','abs'),
('Cable crunches','abs'),
-- Lower back
('Low back hyperextension (with bracing)','lower_back'),
('Hyperextension machine','lower_back'),
-- Triceps
('Single-arm tricep extension','triceps'),
('Rope tricep extension','triceps'),
('V-bar tricep extension','triceps'),
('Straight bar tricep extension','triceps'),
('EZ bar tricep extension','triceps'),
('Dip machine','triceps'),
('Weighted dips','triceps'),
('EZ bar skull crusher','triceps'),
('DB skull crusher','triceps'),
('EZ bar JM press','triceps'),
('EZ bar overhead extension','triceps'),
('Single-arm DB overhead extension','triceps'),
('Overhead single-arm cable extension','triceps'),
('Overhead cable V-bar extension','triceps'),
('Overhead cable rope extension','triceps'),
-- Biceps
('Incline DB curl','biceps'),
('Standing hammer curl','biceps'),
('Seated DB curl','biceps'),
('EZ bar standing curl','biceps'),
('EZ bar spider curl','biceps'),
('DB curl','biceps'),
('Machine preacher curl','biceps'),
('DB preacher curl','biceps'),
('EZ bar preacher curl','biceps'),
('Bayesian cable curl','biceps'),
('EZ bar cable curl','biceps'),
-- Forearms
('Wrist curl','forearms'),
-- Quads
('Leg extension','quads'),
('Hack squat','quads'),
('Pendulum squat','quads'),
('Barbell high-bar squat','quads'),
('Smith high-bar squat','quads'),
('Sissy squat','quads'),
('Leg press, feet low (quad bias)','quads'),
-- Hamstrings
('Lying hamstring curl','hamstrings'),
('Seated hamstring curl','hamstrings'),
-- Glutes
('Hip thrust','glutes'),
('Glute kickback','glutes'),
('Lateral glute kickback','glutes'),
('Abduction machine','glutes'),
('Back-rounded hyperextension (glute bias)','glutes'),
('Bulgarian split squat, forward lean (glute bias)','glutes'),
('Smith squat, feet forward (glute bias)','glutes'),
('Hack squat, feet high (glute bias)','glutes'),
('Leg press, feet high (glute bias)','glutes'),
-- Adductors
('Adductor machine','adductors'),
-- Calves
('Seated calf raise','calves'),
('Standing DB calf raise','calves'),
('Calf raise machine','calves'),
('Calf extension machine','calves'),
-- Multi: glutes + hams
('RDL','glutes_hams'),
('B-stance RDL','glutes_hams'),
('SLDL','glutes_hams'),
('Flat-back hyperextension','glutes_hams'),
-- Multi: quads + glutes
('Bulgarian split squat (neutral)','quads_glutes'),
('Walking lunges','quads_glutes'),
('Reverse lunges','quads_glutes');
