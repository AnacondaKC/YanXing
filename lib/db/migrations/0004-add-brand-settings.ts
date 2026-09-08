import type { DatabaseSync } from 'node:sqlite'

export const addBrandSettingsSql = `
  CREATE TABLE brand_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    display_text TEXT NOT NULL CHECK (length(display_text) BETWEEN 1 AND 60),
    header_logo BLOB,
    header_logo_mime TEXT CHECK (header_logo_mime IN ('image/png', 'image/jpeg', 'image/webp')),
    login_watermark BLOB,
    login_watermark_mime TEXT CHECK (login_watermark_mime IN ('image/png', 'image/jpeg', 'image/webp')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT,
    updated_by TEXT,
    CHECK ((header_logo IS NULL) = (header_logo_mime IS NULL)),
    CHECK ((login_watermark IS NULL) = (login_watermark_mime IS NULL))
  );
  INSERT INTO brand_settings(id, display_text, revision) VALUES (1, '研行产业政策研究团队', 1);
`

export function applyAddBrandSettings(database: DatabaseSync) {
  database.exec(addBrandSettingsSql)
}
