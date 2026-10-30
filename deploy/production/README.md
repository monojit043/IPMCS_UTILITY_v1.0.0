# IPMCS Utility — production (office apps server, PC-1)

IPMCS runs next to ePULSE on the apps server: folder `E:\IPMCS_1.0`, port **8090**, its own database
`IPMCS_UTILITY_1.0`. It reads ePULSE (`ePULSE_v1.0.0`) live and read-only — logins, jobs and units come
through ePULSE's link to the PIMS server, so **nothing is needed on the PIMS server (PC-2)**.
It uses ePULSE's Node runtime (`E:\ePULSE_v1.0.0\backend\node-v22.19.0-win-x64`).

Packages are zips named `IPMCS_<date>_<commit>[_full].zip`. `_full` ones carry the libraries
(node_modules); the first install needs a `_full` one. Every package installs **or** updates.

---

## First install (once)

Before you start: ePULSE is installed and running on this server, and you have its `SSO_SECRET` (in
`E:\ePULSE_v1.0.0\backend\.env`).

1. Unzip the package to `E:\updates\` → a folder `E:\updates\IPMCS_<date>_<commit>_full`.
2. In that folder, double-click `deploy\production\apply_update.bat`. It installs into `E:\IPMCS_1.0` and
   creates `E:\IPMCS_1.0\backend\.env` from the template.
3. Open `E:\IPMCS_1.0\backend\.env` in Notepad and fill in:
   - `DB_PASSWORD` = this server's postgres password
   - `SSO_SECRET` = **exactly** the same as in ePULSE's `.env`
   - `JWT_SECRET` is filled in automatically by step 1.
4. Double-click `E:\IPMCS_1.0\deploy\production\step1_setup_database.bat`. It creates the database and its
   tables, and loads the standard BoM lists (Item List, Assembly Directory). It stops without changing
   anything if the database already has tables.
5. Double-click `E:\IPMCS_1.0\deploy\production\step2_start_ipmcs.bat`. Keep the window open; closing it
   stops IPMCS.
6. Firewall (Command Prompt **as Administrator**), so other PCs can open it:
   ```bat
   netsh advfirewall firewall add rule name="IPMCS (8090)" dir=in action=allow protocol=TCP localport=8090
   ```
7. Test: log in to ePULSE (`http://10.40.36.232:3000/gateway-login.html`), open **MTO Collection and
   Consolidation** from the gateway — you should be logged in already. A GL / SGL of a job appoints a
   Material Lead in the Team tab.

## Updates (every new version)

1. Unzip the new package to `E:\updates\`.
2. Close the "IPMCS Utility v1.0.0" window (IPMCS must be stopped).
3. In the **unzipped package** folder, double-click `deploy\production\apply_update.bat`. It:
   - backs up the database and the current code to `E:\backups\IPMCS\<date>_before_<commit>`
   - replaces the code — `.env` and the data are never touched
   - updates the database tables
4. Start it again: `E:\IPMCS_1.0\deploy\production\step2_start_ipmcs.bat`.

The installed version is in `E:\IPMCS_1.0\RELEASE.json` (`version`, `commit`).

## Going back (rollback)

1. Close the IPMCS window.
2. Double-click `E:\IPMCS_1.0\deploy\production\rollback.bat` (it takes the last update's backup; another
   one: `rollback.bat E:\backups\IPMCS\<folder>`).
3. Type `YES` to put the old code back. It then asks whether to put the **database** back too — only do
   that if the update damaged data: everything entered after the update is lost. Press Enter to keep it.
4. Start it again (step 2).

## If something fails

| Message | Fix |
|---|---|
| `IPMCS is running (port 8090)` | close the IPMCS window first |
| `password authentication failed` | `DB_PASSWORD` in `backend\.env` |
| `database "ePULSE_v1.0.0" does not exist` | `EPULSE_DB_NAME` in `backend\.env` |
| `needs new libraries ... FULL package` | ask for the `_full` package of that version |
| `pg_dump.exe not found` | PostgreSQL is not in `C:\Program Files\PostgreSQL\18` — run `set PGBIN=<its bin folder>` first, in the same Command Prompt |
| Login loops back to the login page | `SSO_SECRET` differs from ePULSE's |
