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
  IF to_regclass('public.ipmcs_user_assignments') IS NOT NULL THEN
    ALTER SEQUENCE IF EXISTS user_assignments_id_seq RENAME TO ipmcs_user_assignments_id_seq;
    FOR r IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'public.ipmcs_user_assignments'::regclass AND conname LIKE 'user\_assignments%' LOOP
      EXECUTE format('ALTER TABLE ipmcs_user_assignments RENAME CONSTRAINT %I TO %I', r.conname, 'ipmcs_' || r.conname);
    END LOOP;
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

-- IPMCS team per job + unit: Material Leads (ML) and Job Engineers (JE).
-- Leads (GL / SGL) come live from PC-2 and are never stored here.
CREATE TABLE IF NOT EXISTS ipmcs_user_assignments (
  id          SERIAL PRIMARY KEY,
  emp_id      VARCHAR(50) NOT NULL,
  job_no      VARCHAR(20) NOT NULL,
  unit_no     VARCHAR(10) NOT NULL,
  role        VARCHAR(10) NOT NULL CHECK (role IN ('ML','JE')),
  assigned_by VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (emp_id, job_no, unit_no)
);

-- One-time (2026-10-26): from a global ADMIN / JE list to roles per job + unit.
-- The team of a job + unit is:
--   Lead — GL of the job + unit or SGL of the job on PC-2 (live, never stored)
--   ML   — Material Lead, appointed in IPMCS by a Lead
--   JE   — Job Engineer, added in IPMCS by a Lead or an ML
-- The old global ADMIN row is dropped (its rights now belong to Leads / MLs).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ipmcs_user_assignments' AND column_name = 'job_no') THEN
    DELETE FROM ipmcs_user_assignments;
    ALTER TABLE ipmcs_user_assignments DROP CONSTRAINT IF EXISTS ipmcs_user_assignments_emp_id_key;
    ALTER TABLE ipmcs_user_assignments DROP CONSTRAINT IF EXISTS ipmcs_user_assignments_role_check;
    ALTER TABLE ipmcs_user_assignments ADD COLUMN job_no VARCHAR(20) NOT NULL;
    ALTER TABLE ipmcs_user_assignments ADD COLUMN unit_no VARCHAR(10) NOT NULL;
    ALTER TABLE ipmcs_user_assignments ADD CONSTRAINT ipmcs_user_assignments_role_check CHECK (role IN ('ML','JE'));
    ALTER TABLE ipmcs_user_assignments ADD CONSTRAINT ipmcs_user_assignments_emp_job_unit_key UNIQUE (emp_id, job_no, unit_no);
  END IF;
END $$;

-- Every team change (who added / changed / removed whom, when)
CREATE TABLE IF NOT EXISTS ipmcs_assignment_log (
  id          SERIAL PRIMARY KEY,
  job_no      VARCHAR(20) NOT NULL,
  unit_no     VARCHAR(10) NOT NULL,
  emp_id      VARCHAR(50) NOT NULL,
  action      VARCHAR(10) NOT NULL CHECK (action IN ('add','change','remove')),
  old_role    VARCHAR(10),
  new_role    VARCHAR(10),
  done_by     VARCHAR(50) NOT NULL,
  done_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ipmcs_assignment_log_unit ON ipmcs_assignment_log (job_no, unit_no, done_at);

-- One row per line + zone an engineer has saved MTO for. The line itself
-- is identified the COSMAS way (Service / Unit / LSR NO / Subline No.);
-- the zone is IPMCS's split of a line between engineers.
-- COSMAS header columns hold only what the engineer types. Line data
-- (piping class, insulation, P&T) is never stored — it is read-only, live.
CREATE TABLE IF NOT EXISTS mto_line_zones (
  id                 SERIAL PRIMARY KEY,
  job_no             VARCHAR(20)  NOT NULL,
  unit_no            VARCHAR(10)  NOT NULL,
  service            VARCHAR(20)  NOT NULL,
  lsr_no             VARCHAR(20)  NOT NULL,
  subline_no         VARCHAR(10)  NOT NULL DEFAULT '',
  zone               VARCHAR(3)   NOT NULL,
  contr_code         VARCHAR(20),
  drg_indicator      CHAR(1) CHECK (drg_indicator IN ('P','I','G','S')),
  drg_area_no        VARCHAR(20),
  drg_rev_no         VARCHAR(20),
  ins_extent         VARCHAR(40),
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
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  -- unique per MTO folder: see "MTO folders" at the end (folder_id)
);
CREATE INDEX IF NOT EXISTS idx_mto_line_zones_unit ON mto_line_zones (job_no, unit_no);
-- 2026-10-25: piping class / INS type / OPR & Des temps were editable copies of
-- line data — now read-only from the sources, so the columns are dropped.
ALTER TABLE mto_line_zones DROP COLUMN IF EXISTS piping_class, DROP COLUMN IF EXISTS ins_type,
  DROP COLUMN IF EXISTS opr_temp1, DROP COLUMN IF EXISTS opr_temp2,
  DROP COLUMN IF EXISTS des_temp1, DROP COLUMN IF EXISTS des_temp2;

-- One-time (2026-10-25): BoM tables renamed to what they hold, with their
-- id sequences, indexes and constraint names —
--   mto_items → manual_mto_data, dump_items → model_dump_data,
--   extracted_items → sppid_extracted_data
-- and the prototype's columns renamed to the COSMAS names:
--   spec → piping_class, size → dia1.
DO $$
DECLARE
  r record;
  m text[];
  renames text[][] := ARRAY[
    ARRAY['mto_items', 'manual_mto_data'],
    ARRAY['dump_items', 'model_dump_data'],
    ARRAY['extracted_items', 'sppid_extracted_data']];
BEGIN
  FOREACH m SLICE 1 IN ARRAY renames LOOP
    IF to_regclass('public.' || m[1]) IS NOT NULL AND to_regclass('public.' || m[2]) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', m[1], m[2]);
      EXECUTE format('ALTER SEQUENCE IF EXISTS %I RENAME TO %I', m[1] || '_id_seq', m[2] || '_id_seq');
      EXECUTE format('ALTER INDEX IF EXISTS %I RENAME TO %I', 'idx_' || m[1] || '_zone', 'idx_' || m[2] || '_zone');
    END IF;
    IF to_regclass('public.' || m[2]) IS NOT NULL THEN
      FOR r IN SELECT conname FROM pg_constraint
               WHERE conrelid = to_regclass('public.' || m[2]) AND conname LIKE replace(m[1], '_', '\_') || '%' LOOP
        EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', m[2], r.conname, m[2] || substr(r.conname, length(m[1]) + 1));
      END LOOP;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = m[2] AND column_name = 'spec') THEN
        EXECUTE format('ALTER TABLE %I RENAME COLUMN spec TO piping_class', m[2]);
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = m[2] AND column_name = 'size') THEN
        EXECUTE format('ALTER TABLE %I RENAME COLUMN size TO dia1', m[2]);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Bill of Material rows of a line + zone, in COSMAS columns:
-- Piping Class | Input Code | Item Code | Dia1 | Dia2 | Qty.
--   manual_mto_data      — MTO typed in the MTO Input tab
--   model_dump_data      — MTO from the 3D model dump (MTO from Dump Check tab)
--   sppid_extracted_data — quantities extracted from the SmartPlant P&ID,
--                          the reference both tabs are compared with
CREATE TABLE IF NOT EXISTS manual_mto_data (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  piping_class  VARCHAR(40),
  input_code    VARCHAR(60),
  item_code     VARCHAR(60),
  dia1          VARCHAR(20),
  dia2          VARCHAR(20),
  qty           NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_dump_data (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  piping_class  VARCHAR(40),
  input_code    VARCHAR(60),
  item_code     VARCHAR(60),
  dia1          VARCHAR(20),
  dia2          VARCHAR(20),
  qty           NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sppid_extracted_data (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  piping_class  VARCHAR(40),
  input_code    VARCHAR(60),
  item_code     VARCHAR(60),
  dia1          VARCHAR(20),
  dia2          VARCHAR(20),
  qty           NUMERIC NOT NULL DEFAULT 0
);

-- MTO revision history: every Save of a line + zone adds one row, never
-- overwritten. `basis` is the line data exactly as it was when saved (line
-- no., size, piping class, insulation, P&T, the P&ID names + revisions and the
-- line-list revision it came from), so any MTO can be traced back to what it
-- was based on — the line data itself is otherwise only ever read live.
-- `header` / `rows` are the COSMAS header and the BoM rows of that tab as saved.
-- Deleted line + zones (Search/Delete Lines): the zone row, its MTO / model
-- dump rows and ALL its revisions are archived here as one snapshot before
-- the delete, so a deleted MTO can still be traced back.
CREATE TABLE IF NOT EXISTS mto_line_zone_deletions (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL,
  job_no        VARCHAR(20) NOT NULL,
  unit_no       VARCHAR(10) NOT NULL,
  service       VARCHAR(20) NOT NULL,
  lsr_no        VARCHAR(20) NOT NULL,
  subline_no    VARCHAR(10) NOT NULL DEFAULT '',
  zone          VARCHAR(3)  NOT NULL,
  snapshot      JSONB NOT NULL,
  reason        TEXT,
  deleted_by    VARCHAR(50) NOT NULL,
  deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mto_line_zone_revisions (
  id            SERIAL PRIMARY KEY,
  line_zone_id  INTEGER NOT NULL REFERENCES mto_line_zones(id) ON DELETE CASCADE,
  rev_no        INTEGER NOT NULL,
  kind          VARCHAR(10) NOT NULL CHECK (kind IN ('mto','dump')),
  saved_by      VARCHAR(50),
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  basis         JSONB NOT NULL,
  header        JSONB NOT NULL,
  rows          JSONB NOT NULL,
  row_count     INTEGER NOT NULL,
  note          TEXT,
  UNIQUE (line_zone_id, rev_no)
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

    FOREACH t IN ARRAY ARRAY['manual_mto_data', 'model_dump_data', 'sppid_extracted_data'] LOOP
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

CREATE INDEX IF NOT EXISTS idx_manual_mto_data_zone ON manual_mto_data (line_zone_id);
CREATE INDEX IF NOT EXISTS idx_model_dump_data_zone ON model_dump_data (line_zone_id);
CREATE INDEX IF NOT EXISTS idx_sppid_extracted_data_zone ON sppid_extracted_data (line_zone_id);

-- P&ID library: folders (e.g. "MTO-1") of ONE job + unit, made by its Lead /
-- Material Lead, referencing sheets of ePULSE's P&ID module (pid_master_index
-- ids) of that job + unit — ePULSE is the source of truth for P&IDs; IPMCS only
-- records which sheets were selected for MTO work and the highlight progress.
CREATE TABLE IF NOT EXISTS pid_folders (
  id          SERIAL PRIMARY KEY,
  job_no      VARCHAR(20),
  unit_no     VARCHAR(10),
  name        VARCHAR(100) NOT NULL,
  created_by  VARCHAR(50),          -- employee ID
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_no, unit_no, name)
);
-- One-time (2026-10-26): folders were global; now per job + unit. Existing
-- folders get their job + unit from their P&IDs (db/migrate.js).
ALTER TABLE pid_folders ADD COLUMN IF NOT EXISTS job_no VARCHAR(20);
ALTER TABLE pid_folders ADD COLUMN IF NOT EXISTS unit_no VARCHAR(10);
ALTER TABLE pid_folders DROP CONSTRAINT IF EXISTS pid_folders_name_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pid_folders'::regclass AND contype = 'u') THEN
    ALTER TABLE pid_folders ADD CONSTRAINT pid_folders_job_unit_name_key UNIQUE (job_no, unit_no, name);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pid_folders_unit ON pid_folders (job_no, unit_no);

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
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  -- unique per drawing REVISION: see "MTO folders" at the end (revision_doc_id)
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

-- ── MTO folders: fixed sets of P&ID revisions (decided 2026-10-26) ──
-- An ML / Lead builds a folder (MTO-1, MTO-2 …); each P&ID added is PINNED at
-- the revision current at that moment (document_id = ePULSE pid_documents.id).
-- "Freeze" locks the folder and copies each P&ID's then-current revision PDF
-- into IPMCS (mto_folder_files). JEs take MTO only in frozen folders and MTO
-- is separate per folder; the LINES open for MTO are always every line-list
-- line + every line on the latest P&IDs. Highlights are made on the folder's
-- copies; each copy keeps its fresh PDF and a highlighted PDF.
ALTER TABLE pid_folders ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'open';
ALTER TABLE pid_folders ADD COLUMN IF NOT EXISTS frozen_by VARCHAR(50);
ALTER TABLE pid_folders ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE pid_folder_selections ADD COLUMN IF NOT EXISTS document_id INTEGER;   -- pinned revision
ALTER TABLE pid_folder_selections ADD COLUMN IF NOT EXISTS rev_label VARCHAR(20);
ALTER TABLE pid_user_highlights ADD COLUMN IF NOT EXISTS revision_doc_id INTEGER;
ALTER TABLE pid_zone_breaks ADD COLUMN IF NOT EXISTS revision_doc_id INTEGER;
ALTER TABLE mto_line_zones ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES pid_folders(id);
ALTER TABLE mto_line_zone_deletions ADD COLUMN IF NOT EXISTS folder_id INTEGER;

-- The P&ID files of a frozen MTO folder, copied out of ePULSE at Freeze:
-- fresh_pdf = the drawing as issued, highlighted_pdf = the same with every
-- engineer's highlights drawn in (rewritten on each highlight save).
CREATE TABLE IF NOT EXISTS mto_folder_files (
  id               SERIAL PRIMARY KEY,
  folder_id        INTEGER NOT NULL REFERENCES pid_folders(id) ON DELETE CASCADE,
  master_index_id  INTEGER NOT NULL,       -- ePULSE pid_master_index.id (the drawing)
  document_id      INTEGER NOT NULL,       -- ePULSE pid_documents.id (the revision copied)
  pid_name         VARCHAR(150) NOT NULL,
  rev_label        VARCHAR(20),
  file_name        VARCHAR(255),
  fresh_pdf        BYTEA NOT NULL,
  fresh_size       INTEGER NOT NULL,
  fresh_sha256     CHAR(64) NOT NULL,
  highlighted_pdf  BYTEA,
  highlighted_at   TIMESTAMPTZ,
  copied_by        VARCHAR(50),            -- employee ID who froze the folder
  copied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (folder_id, master_index_id)
);
ALTER TABLE pid_user_highlights ADD COLUMN IF NOT EXISTS folder_file_id INTEGER REFERENCES mto_folder_files(id) ON DELETE CASCADE;

-- Freeze takes EVERY active P&ID of the unit's ePULSE index. One that has no
-- PDF at that moment is recorded here, so the folder shows what it lacks and
-- lines drawn on it are flagged "PDF missing".
CREATE TABLE IF NOT EXISTS mto_folder_missing_pids (
  id               SERIAL PRIMARY KEY,
  folder_id        INTEGER NOT NULL REFERENCES pid_folders(id) ON DELETE CASCADE,
  master_index_id  INTEGER NOT NULL,
  pid_name         VARCHAR(150) NOT NULL,
  description      TEXT,
  reason           VARCHAR(100) NOT NULL,   -- 'No PDF uploaded' / 'PDF file not found on disk'
  UNIQUE (folder_id, master_index_id)
);
ALTER TABLE pid_folders ADD COLUMN IF NOT EXISTS freeze_note TEXT;
ALTER TABLE pid_zone_breaks ADD COLUMN IF NOT EXISTS folder_file_id INTEGER REFERENCES mto_folder_files(id) ON DELETE CASCADE;
DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pid_folders_status_check') THEN
    ALTER TABLE pid_folders ADD CONSTRAINT pid_folders_status_check CHECK (status IN ('open', 'frozen'));
  END IF;
  -- line + zone unique per folder (drop the older unit-wide key, whatever its name)
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'mto_line_zones'::regclass AND contype = 'u'
           AND conname <> 'mto_line_zones_folder_line_zone_key' LOOP
    EXECUTE format('ALTER TABLE mto_line_zones DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mto_line_zones_folder_line_zone_key') THEN
    ALTER TABLE mto_line_zones ADD CONSTRAINT mto_line_zones_folder_line_zone_key
      UNIQUE (folder_id, job_no, unit_no, service, lsr_no, subline_no, zone);
  END IF;
  -- highlights unique per folder copy (drop older per-sheet / per-revision keys)
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'pid_user_highlights'::regclass AND contype = 'u'
           AND conname <> 'pid_user_highlights_file_page_emp_key' LOOP
    EXECUTE format('ALTER TABLE pid_user_highlights DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pid_user_highlights_file_page_emp_key') THEN
    ALTER TABLE pid_user_highlights ADD CONSTRAINT pid_user_highlights_file_page_emp_key UNIQUE (folder_file_id, page_num, emp_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_mto_line_zones_folder ON mto_line_zones (folder_id);
CREATE INDEX IF NOT EXISTS idx_pid_zone_breaks_rev ON pid_zone_breaks (revision_doc_id, page_num);
CREATE INDEX IF NOT EXISTS idx_pid_zone_breaks_file ON pid_zone_breaks (folder_file_id, page_num);
