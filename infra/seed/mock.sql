-- Seed de modo mock: 5 cuentas ficticias ACTIVE + 5 prestadores demo.
-- Idempotente. Aplicar con: pnpm --filter @trato/api db:seed:mock:local
-- Los ids (demo_ba_N / seller_N) coinciden con los de accounts.local.sql generado por
-- `register-accounts`, de modo que las cuentas reales reemplazan a las mock sin tocar los tratos.
INSERT INTO demo_bank_accounts (id, alias, pey_bank_account_id, clabe_last4, codi_status, enabled, verified_at) VALUES
  ('demo_ba_1', 'Cuenta demo 1', 'mock_ba_1', '0001', 'ACTIVE', 1, 1763078400000),
  ('demo_ba_2', 'Cuenta demo 2', 'mock_ba_2', '0002', 'ACTIVE', 1, 1763078400000),
  ('demo_ba_3', 'Cuenta demo 3', 'mock_ba_3', '0003', 'ACTIVE', 1, 1763078400000),
  ('demo_ba_4', 'Cuenta demo 4', 'mock_ba_4', '0004', 'ACTIVE', 1, 1763078400000),
  ('demo_ba_5', 'Cuenta demo 5', 'mock_ba_5', '0005', 'ACTIVE', 1, 1763078400000)
ON CONFLICT(id) DO UPDATE SET
  alias = excluded.alias,
  pey_bank_account_id = excluded.pey_bank_account_id,
  clabe_last4 = excluded.clabe_last4,
  codi_status = excluded.codi_status,
  enabled = excluded.enabled,
  verified_at = excluded.verified_at;

INSERT INTO sellers (id, display_name, trade, demo_bank_account_id, created_at) VALUES
  ('seller_1', 'Herrería Don Chuy', 'Herrería', 'demo_ba_1', 1763078400000),
  ('seller_2', 'Carpintería Lupita', 'Carpintería', 'demo_ba_2', 1763078400000),
  ('seller_3', 'Plomería Ramírez', 'Plomería', 'demo_ba_3', 1763078400000),
  ('seller_4', 'Electricista Sofía', 'Electricidad', 'demo_ba_4', 1763078400000),
  ('seller_5', 'Pintura Hermanos Ortega', 'Pintura', 'demo_ba_5', 1763078400000)
ON CONFLICT(id) DO UPDATE SET
  display_name = excluded.display_name,
  trade = excluded.trade,
  demo_bank_account_id = excluded.demo_bank_account_id;
