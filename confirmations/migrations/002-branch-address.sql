-- confirmations/migrations/002-branch-address.sql
--
-- Agrega branch_address para que MelanIA pueda incluir la dirección de
-- la sucursal en los mensajes de confirmación al paciente.
--
-- La dirección viene en cada cita Medinet (sucursal.direccion del response
-- de all-appointments) y se persiste en intake. Single source of truth =
-- Medinet, así un cambio de dirección propaga al siguiente upsert.
--
-- Las sucursales de telemedicina (branchId 2, 3) no tienen direccion
-- física en Medinet (viene null), por eso la columna es NULLABLE.

ALTER TABLE confirmations.appointments
  ADD COLUMN IF NOT EXISTS branch_address TEXT;
