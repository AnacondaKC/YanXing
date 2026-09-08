import type { DatabaseSync } from 'node:sqlite'

export const updateDefaultBrandSql = `
  UPDATE brand_settings
  SET display_text = '研行致远
产业政策研究团队'
  WHERE id = 1
    AND revision = 1
    AND display_text = '研行产业政策研究团队'
    AND header_logo IS NULL
    AND login_watermark IS NULL
    AND updated_at IS NULL
    AND updated_by IS NULL;
`

export function applyUpdateDefaultBrand(database: DatabaseSync) {
  database.exec(updateDefaultBrandSql)
}
