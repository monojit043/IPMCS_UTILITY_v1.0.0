-- Superseded by pid_user_highlights (per document/page/user instead of a
-- single merged blob keyed by an arbitrary string).
DROP TABLE IF EXISTS highlights;

-- Local identity cache only: name/password now live in MASTER_EMPLOYEE_DB and
-- are never stored here. This table exists purely so pid_* tables below have
-- a stable local integer id to key off; it's upserted on every login.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  emp_id        VARCHAR(50) UNIQUE NOT NULL,
  name          VARCHAR(100) NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drop columns left over from the old self-contained login (role/password
-- moved to user_assignments below and MASTER_EMPLOYEE_DB respectively).
-- Safe to re-run: IF EXISTS makes each drop a no-op once already applied.
ALTER TABLE users DROP COLUMN IF EXISTS role;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- IPMCS-specific role per employee (ADMIN can manage the P&ID library;
-- everyone else is a Job Engineer). Maintained here directly, independent
-- of PIMS's own, more granular role vocabulary. Employees with no row here
-- default to JE (see auth.service.js).
CREATE TABLE IF NOT EXISTS user_assignments (
  id          SERIAL PRIMARY KEY,
  emp_id      VARCHAR(50) UNIQUE NOT NULL,
  role        VARCHAR(10) NOT NULL CHECK (role IN ('ADMIN','JE')),
  assigned_by VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lines (
  id                    SERIAL PRIMARY KEY,
  tag                   VARCHAR(50) NOT NULL,
  fluid                 VARCHAR(20),
  rating                VARCHAR(20),
  description           VARCHAR(200),
  sheet                 VARCHAR(20),
  status                VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inprogress','complete')),
  items_count           INTEGER NOT NULL DEFAULT 0,
  service               VARCHAR(10) NOT NULL,
  unit_no               VARCHAR(10) NOT NULL,
  seq_no                VARCHAR(10) NOT NULL,
  subline_no            VARCHAR(10) NOT NULL,
  op_pressure           VARCHAR(30),
  op_temp               VARCHAR(30),
  design_pressure       VARCHAR(30),
  design_temp           VARCHAR(30),
  insulation_type       VARCHAR(50),
  insulation_thickness  VARCHAR(30),
  UNIQUE (service, unit_no, seq_no, subline_no)
);

-- Reworked into a clean mirror of PIMS_SQL.piping_line_list's own column
-- names — tag/subline_no renamed to line_no/zone to match exactly, and
-- fields PIMS has no equivalent for (fluid/rating/description/sheet/
-- op+design pressure+temp/insulation) are dropped rather than carried as
-- dead weight. Lines are no longer bulk-synced ahead of time: dropdown
-- browsing now queries PIMS live (see lines.service.js), and a row only
-- lands here the moment a specific line is actually resolved for MTO work
-- (resolveLine upserts it) — so this table is "lines currently being
-- tracked in IPMCS", not a full mirror of every PIMS line.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS job_no VARCHAR(20);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS piping_spec VARCHAR(20);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS size_in VARCHAR(10);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS source VARCHAR(20);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS created_by VARCHAR(50);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Old placeholder rows predate job_no existing at all — no longer
-- meaningful now that lines are sourced from PIMS. ON DELETE CASCADE also
-- clears any mto/dump/extracted items that were attached to them.
DELETE FROM lines WHERE job_no IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lines' AND column_name = 'tag') THEN
    ALTER TABLE lines RENAME COLUMN tag TO line_no;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lines' AND column_name = 'subline_no') THEN
    ALTER TABLE lines RENAME COLUMN subline_no TO zone;
  END IF;
END $$;

ALTER TABLE lines DROP COLUMN IF EXISTS fluid;
ALTER TABLE lines DROP COLUMN IF EXISTS rating;
ALTER TABLE lines DROP COLUMN IF EXISTS description;
ALTER TABLE lines DROP COLUMN IF EXISTS sheet;
ALTER TABLE lines DROP COLUMN IF EXISTS op_pressure;
ALTER TABLE lines DROP COLUMN IF EXISTS op_temp;
ALTER TABLE lines DROP COLUMN IF EXISTS design_pressure;
ALTER TABLE lines DROP COLUMN IF EXISTS design_temp;
ALTER TABLE lines DROP COLUMN IF EXISTS insulation_type;
ALTER TABLE lines DROP COLUMN IF EXISTS insulation_thickness;

-- Re-added, but now genuinely sourced (see lines.service.js resolveLine)
-- from PIMS_SQL.linelist_lines, joined via linelist_uploads for a reliable
-- job_no (linelist_lines.pid_no is not a trustworthy job_no source) and
-- matched on job_no+unit_no+service+line_no — linelist_lines has no zone
-- column, so these apply to every zone/subline of a given line.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS op_pressure VARCHAR(30);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS op_temp VARCHAR(30);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS design_pressure VARCHAR(30);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS design_temp VARCHAR(30);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS insulation_type VARCHAR(50);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS insulation_thickness VARCHAR(30);

ALTER TABLE lines ALTER COLUMN job_no SET NOT NULL;

-- The same service+unit+seq+zone combination can legitimately repeat across
-- different jobs (unit numbers like "101" aren't globally unique in PIMS),
-- so uniqueness is scoped by job_no too. Found/dropped by column set rather
-- than a guessed name, so this is safe to re-run.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT con.conname INTO con_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'lines' AND con.contype = 'u';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lines DROP CONSTRAINT %I', con_name);
  END IF;
  ALTER TABLE lines ADD CONSTRAINT lines_job_unit_service_seq_zone_key
    UNIQUE (job_no, unit_no, service, seq_no, zone);
END $$;

DROP TABLE IF EXISTS line_sync_state;

CREATE TABLE IF NOT EXISTS mto_items (
  id           SERIAL PRIMARY KEY,
  line_id      INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  category     VARCHAR(30),
  description  VARCHAR(200) NOT NULL,
  size         VARCHAR(20),
  spec         VARCHAR(20),
  sch          VARCHAR(20),
  unit         VARCHAR(10),
  qty          NUMERIC NOT NULL DEFAULT 0,
  remarks      VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS dump_items (
  id           SERIAL PRIMARY KEY,
  line_id      INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  category     VARCHAR(30),
  description  VARCHAR(200) NOT NULL,
  size         VARCHAR(20),
  spec         VARCHAR(20),
  sch          VARCHAR(20),
  unit         VARCHAR(10),
  qty          NUMERIC NOT NULL DEFAULT 0,
  remarks      VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS extracted_items (
  id           SERIAL PRIMARY KEY,
  line_id      INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  description  VARCHAR(200) NOT NULL,
  size         VARCHAR(20),
  spec         VARCHAR(20),
  sch          VARCHAR(20),
  unit         VARCHAR(10),
  qty          NUMERIC NOT NULL DEFAULT 0
);

-- P&ID library: ADMIN-curated folders (e.g. "MTO-1") that reference sheets
-- from PIMS_SQL's own P&ID library (pid_master_index / pid_documents)
-- rather than files uploaded directly into IPMCS — PIMS is the source of
-- truth for P&IDs; IPMCS only records which sheets an admin has selected
-- for MTO work and every user's highlight progress on them.
CREATE TABLE IF NOT EXISTS pid_folders (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pid_user_highlights.document_id used to FK to a local pid_documents
-- table of admin-uploaded files; that table is gone now that folders hold
-- PIMS references instead, so drop the FK before dropping the table it
-- points to. Found by column rather than a guessed name, safe to re-run.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT con.conname INTO con_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
  WHERE rel.relname = 'pid_user_highlights' AND con.contype = 'f' AND att.attname = 'document_id';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pid_user_highlights DROP CONSTRAINT %I', con_name);
  END IF;
END $$;
DROP TABLE IF EXISTS pid_documents;

-- One row per PIMS P&ID sheet (pid_master_index.id) an admin has selected
-- into a folder. No snapshot of the document itself is stored — the
-- current pid_documents revision for that master index is always resolved
-- live from PIMS (see pimsPid.service.js), so a folder automatically
-- reflects PIMS's latest revision without any re-sync step.
CREATE TABLE IF NOT EXISTS pid_folder_selections (
  id                    SERIAL PRIMARY KEY,
  folder_id             INTEGER NOT NULL REFERENCES pid_folders(id) ON DELETE CASCADE,
  pims_master_index_id  INTEGER NOT NULL,
  added_by              INTEGER REFERENCES users(id),
  added_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (folder_id, pims_master_index_id)
);

-- document_id holds a PIMS pid_master_index id — cross-database FKs aren't
-- possible in Postgres, so this is unconstrained locally by design. Keyed
-- by the master index id (the stable "sheet" identity) rather than a
-- specific pid_documents revision id, so a user's highlights stay attached
-- to the same P&ID sheet across PIMS file revisions.
CREATE TABLE IF NOT EXISTS pid_user_highlights (
  id           SERIAL PRIMARY KEY,
  document_id  INTEGER NOT NULL,
  page_num     INTEGER NOT NULL DEFAULT 1,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  strokes      JSONB NOT NULL DEFAULT '[]',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_num, user_id)
);

-- Auto-detected junctions where two different users' highlight strokes
-- touch on the same sheet — marks where one user's worked zone/subline
-- hands off to another's on the actual drawing (see pidHighlights.service.js).
CREATE TABLE IF NOT EXISTS pid_zone_breaks (
  id           SERIAL PRIMARY KEY,
  document_id  INTEGER NOT NULL,
  page_num     INTEGER NOT NULL DEFAULT 1,
  x            NUMERIC NOT NULL,
  y            NUMERIC NOT NULL,
  user_a_id    INTEGER NOT NULL REFERENCES users(id),
  user_b_id    INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which zone (piping_line_list.zone, e.g. "A"/"B") each side of a break
-- belongs to — only known when the stroke was drawn via a specific line's
-- "Highlight P&ID" button (see pid-viewer.js), null for highlights made by
-- browsing the P&ID library with no line context.
ALTER TABLE pid_zone_breaks ADD COLUMN IF NOT EXISTS zone_a VARCHAR(10);
ALTER TABLE pid_zone_breaks ADD COLUMN IF NOT EXISTS zone_b VARCHAR(10);

-- Lines now come from ePULSE (line_list + lines read off current P&IDs, see
-- lines.service.js) instead of PIMS_SQL. Neither source has a zone, so the
-- zone is set by the engineer in IPMCS. Line-list sizes can list several
-- ("4\", 2\""), so size / line no. are widened. pid_no = every P&ID the line
-- appears on; data_mismatch = where line list and P&ID disagree.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pid_no TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS data_mismatch TEXT;
ALTER TABLE lines ALTER COLUMN size_in TYPE VARCHAR(60);
ALTER TABLE lines ALTER COLUMN line_no TYPE VARCHAR(150);
ALTER TABLE lines ALTER COLUMN piping_spec TYPE VARCHAR(40);
ALTER TABLE lines ALTER COLUMN created_by TYPE VARCHAR(50);

-- COSMAS Bill of Material layout (2026-10-23).
-- Line header: OPR/Des Temp 2 = the line list's minimum operating / design
-- temperature. Everything the engineer enters or overrides in the COSMAS
-- header (Contr.Code, DRG indicator/area/rev, INS extent, batch, cleaning
-- code, third parties, bolt tensioning, and any edited piping class / INS
-- type / temperatures) is kept in `cosmas`, so re-opening a line — which
-- refreshes the source columns — never overwrites what was typed.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS op_temp2 VARCHAR(30);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS design_temp2 VARCHAR(30);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS cosmas JSONB NOT NULL DEFAULT '{}';

-- Item rows in COSMAS terms: Piping Class (spec) | Input Code | Item Code |
-- Dia1 (size) | Dia2 | Qty. Description is no longer required.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mto_items', 'dump_items', 'extracted_items'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS input_code VARCHAR(60)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS item_code VARCHAR(60)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS dia2 VARCHAR(20)', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN description DROP NOT NULL', t);
  END LOOP;
END $$;
