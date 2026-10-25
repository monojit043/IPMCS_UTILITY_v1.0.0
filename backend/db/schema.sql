-- IPMCS schema — final state, safe to re-run (npm run migrate).
--
-- What IPMCS stores is only what engineers ENTER. Line data (size, class,
-- insulation, P&T, P&ID no.) is never copied: it is read live from ePULSE
-- (line_list + lines read off current P&IDs) every time — see
-- services/lineData.service.js.

-- People are never copied into IPMCS: everyone is referred to by employee
-- ID (e.g. A725); names are read live from PC-2 through ePULSE.

-- One-time (2026-10-25): the old local `users` cache is gone and the Admin
-- table was renamed. For a database still in the old shape, move the P&ID
-- tables from users.id to employee IDs, then drop `users`.
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.user_assignments') IS NOT NULL AND to_regclass('public.ipmcs_user_assignments') IS NULL THEN
    ALTER TABLE user_assignments RENAME TO ipmcs_user_assignments;
  END IF;
  IF to_regclass('public.users') IS NOT NULL THEN
    FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
             WHERE contype = 'f' AND confrelid = 'public.users'::regclass LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
    IF to_regclass('public.pid_folders') IS NOT NULL THEN
      ALTER TABLE pid_folders ALTER COLUMN created_by TYPE VARCHAR(50) USING created_by::text;
      UPDATE pid_folders f SET created_by = u.emp_id FROM users u WHERE f.created_by = u.id::text;
      ALTER TABLE pid_folder_selections ALTER COLUMN added_by TYPE VARCHAR(50) USING added_by::text;
      UPDATE pid_folder_selections s SET added_by = u.emp_id FROM users u WHERE s.added_by = u.id::text;
      ALTER TABLE pid_user_highlights ALTER COLUMN user_id TYPE VARCHAR(50) USING user_id::text;
      UPDATE pid_user_highlights h SET user_id = u.emp_id FROM users u WHERE h.user_id = u.id::text;
      ALTER TABLE pid_user_highlights RENAME COLUMN user_id TO emp_id;
      ALTER TABLE pid_zone_breaks ALTER COLUMN user_a_id TYPE VARCHAR(50) USING user_a_id::text,
                                  ALTER COLUMN user_b_id TYPE VARCHAR(50) USING user_b_id::text;
      UPDATE pid_zone_breaks z SET user_a_id = u.emp_id FROM users u WHERE z.user_a_id = u.id::text;
      UPDATE pid_zone_breaks z SET user_b_id = u.emp_id FROM users u WHERE z.user_b_id = u.id::text;
      ALTER TABLE pid_zone_breaks RENAME COLUMN user_a_id TO emp_a;
      ALTER TABLE pid_zone_breaks RENAME COLUMN user_b_id TO emp_b;
    END IF;
    DROP TABLE users;
  END IF;
END $$;

-- IPMCS's own Admin list (ADMIN may create P&ID folders and pick drawings
-- into them) — not taken from PC-2 roles. Anyone without a row is a JE.
CREATE TABLE IF NOT EXISTS ipmcs_user_assignments (
  id          SERIAL PRIMARY KEY,
  emp_id      VARCHAR(50) UNIQUE NOT NULL,
  role        VARCHAR(10) NOT NULL CHECK (role IN ('ADMIN','JE')),
  assigned_by VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per line + zone an engineer has saved MTO for. The line itself
-- is identified the COSMAS way (Service / Unit / LSR NO / Subline No.);
-- the zone is IPMCS's split of a line between engineers.
-- COSMAS header columns hold only what the engineer typed: NULL means "use
-- the value from the line list / P&ID" (piping class, INS type, temps).
CREATE TABLE IF NOT EXISTS mto_line_zones (
  id                 SERIAL PRIMARY KEY,
  job_no             VARCHAR(20)  NOT NULL,
  unit_no            VARCHAR(10)  NOT NULL,
  service            VARCHAR(20)  NOT NULL,
  lsr_no             VARCHAR(20)  NOT NULL,
  subline_no         VARCHAR(10)  NOT NULL DEFAULT '',
  zone               VARCHAR(3)   NOT NULL,
  contr_code         VARCHAR(20),
  piping_class       VARCHAR(40),
  drg_indicator      CHAR(1) CHECK (drg_indicator IN ('P','I','G','S')),
  drg_area_no        VARCHAR(20),
  drg_rev_no         VARCHAR(20),
  ins_type           VARCHAR(20),
  ins_extent         VARCHAR(40),
  opr_temp1          VARCHAR(30),
  opr_temp2          VARCHAR(30),
  des_temp1          VARCHAR(30),
  des_temp2          VARCHAR(30),
  batch_no           VARCHAR(30),
  batch_rev_no       VARCHAR(20),
  cleaning_code      VARCHAR(20),
  ins_third_party    VARCHAR(60),
  paint_third_party  VARCHAR(60),
  bolt_tensioning    BOOLEAN NOT NULL DEFAULT false,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inprogress','complete')),
  items_count        INTEGER NOT NULL DEFAULT 0,
  created_by         VARCHAR(50),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         VARCHAR(50),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_no, unit_no, service, lsr_no, subline_no, zone)
);
CREATE INDEX IF NOT EXISTS idx_mto_line_zones_unit ON mto_line_zones (job_no, unit_no);

-- Bill of Material rows of a line + zone: manual MTO, model-dump MTO, and
-- the Smart P&ID extraction they are compared with. COSMAS columns:
-- Piping Class (spec) | Input Code | Item Code | Dia1 (size) | Dia2 | Qty.
CREATE TABLE IF NOT EXISTS mto_items (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  spec          VARCHAR(40),
  input_code    VARCHAR(60),
  item_code     VARCHAR(60),
  size          VARCHAR(20),
  dia2          VARCHAR(20),
  qty           NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dump_items (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  spec          VARCHAR(40),
  input_code    VARCHAR(60),
  item_code     VARCHAR(60),
  size          VARCHAR(20),
  dia2          VARCHAR(20),
  qty           NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS extracted_items (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  spec          VARCHAR(40),
  input_code    VARCHAR(60),
  item_code     VARCHAR(60),
  size          VARCHAR(20),
  dia2          VARCHAR(20),
  qty           NUMERIC NOT NULL DEFAULT 0
);

-- ── One-time move from the old `lines` table (it copied line data from the
-- sources and created a row as soon as a zone was picked). Each old line +
-- zone becomes an mto_line_zones row (LSR NO / Subline split from seq_no,
-- e.g. 05341-01 → 05341 + 01; 05341A stays whole), its items are re-pointed,
-- then `lines` and the items' old columns are dropped. Skipped once done.
DO $$
DECLARE t text;
BEGIN
  IF to_regclass('public.lines') IS NOT NULL THEN
    INSERT INTO mto_line_zones (job_no, unit_no, service, lsr_no, subline_no, zone,
                                status, items_count, created_by, created_at, updated_by, updated_at)
    SELECT job_no, unit_no, service,
           regexp_replace(seq_no, '-[0-9]{1,3}$', ''),
           coalesce(substring(seq_no from '-([0-9]{1,3})$'), ''),
           zone, status, items_count, created_by, created_at, created_by, created_at
    FROM lines
    ON CONFLICT DO NOTHING;

    FOREACH t IN ARRAY ARRAY['mto_items', 'dump_items', 'extracted_items'] LOOP
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'line_id') THEN
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS line_zone_id INTEGER REFERENCES mto_line_zones(id) ON DELETE CASCADE', t);
        EXECUTE format($q$
          UPDATE %I it SET line_zone_id = z.id
          FROM lines l JOIN mto_line_zones z
            ON z.job_no = l.job_no AND z.unit_no = l.unit_no AND z.service = l.service AND z.zone = l.zone
           AND z.lsr_no = regexp_replace(l.seq_no, '-[0-9]{1,3}$', '')
           AND z.subline_no = coalesce(substring(l.seq_no from '-([0-9]{1,3})$'), '')
          WHERE it.line_id = l.id$q$, t);
        EXECUTE format('ALTER TABLE %I DROP COLUMN line_id', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN line_zone_id SET NOT NULL', t);
        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS category, DROP COLUMN IF EXISTS description, DROP COLUMN IF EXISTS sch, DROP COLUMN IF EXISTS unit, DROP COLUMN IF EXISTS remarks', t);
      END IF;
    END LOOP;

    DROP TABLE lines;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mto_items_zone ON mto_items (line_zone_id);
CREATE INDEX IF NOT EXISTS idx_dump_items_zone ON dump_items (line_zone_id);
CREATE INDEX IF NOT EXISTS idx_extracted_items_zone ON extracted_items (line_zone_id);

-- P&ID library: ADMIN-curated folders (e.g. "MTO-1") that reference sheets
-- of ePULSE's P&ID module (pid_master_index ids) — ePULSE is the source of
-- truth for P&IDs; IPMCS only records which sheets an admin selected for MTO
-- work and every user's highlight progress on them.
CREATE TABLE IF NOT EXISTS pid_folders (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  created_by  VARCHAR(50),          -- employee ID
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per P&ID sheet (ePULSE pid_master_index.id) selected into a
-- folder. The current revision is always resolved live from ePULSE.
CREATE TABLE IF NOT EXISTS pid_folder_selections (
  id                    SERIAL PRIMARY KEY,
  folder_id             INTEGER NOT NULL REFERENCES pid_folders(id) ON DELETE CASCADE,
  pims_master_index_id  INTEGER NOT NULL,
  added_by              VARCHAR(50),   -- employee ID
  added_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (folder_id, pims_master_index_id)
);

-- document_id holds an ePULSE pid_master_index id (cross-database, so no
-- FK) — the stable "sheet" identity, so a user's highlights stay attached
-- to the same P&ID across revisions.
CREATE TABLE IF NOT EXISTS pid_user_highlights (
  id           SERIAL PRIMARY KEY,
  document_id  INTEGER NOT NULL,
  page_num     INTEGER NOT NULL DEFAULT 1,
  emp_id       VARCHAR(50) NOT NULL,   -- whose strokes
  strokes      JSONB NOT NULL DEFAULT '[]',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_num, emp_id)
);

-- Auto-detected junctions where two highlight strokes of different zones
-- touch on the same sheet (see pidHighlights.service.js). zone_a / zone_b
-- are only known when the stroke was drawn from a line's "Highlight P&ID".
CREATE TABLE IF NOT EXISTS pid_zone_breaks (
  id           SERIAL PRIMARY KEY,
  document_id  INTEGER NOT NULL,
  page_num     INTEGER NOT NULL DEFAULT 1,
  x            NUMERIC NOT NULL,
  y            NUMERIC NOT NULL,
  emp_a        VARCHAR(50) NOT NULL,   -- the two employees whose
  emp_b        VARCHAR(50) NOT NULL,   -- highlights meet
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pid_zone_breaks ADD COLUMN IF NOT EXISTS zone_a VARCHAR(10);
ALTER TABLE pid_zone_breaks ADD COLUMN IF NOT EXISTS zone_b VARCHAR(10);
