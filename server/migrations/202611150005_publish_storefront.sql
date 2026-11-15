-- Publish the launch edition with the matching web release. Payment availability
-- remains controlled independently by server/config.toml.
-- Do not replace a newer edition already maintained by the operator.
UPDATE storefront
SET documents_published = true, document_version = '2026-11-15.1'
WHERE singleton AND document_version = '2026-11-15';
