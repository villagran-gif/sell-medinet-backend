-- 002-relax-user-fks.sql
-- Zendesk API devuelve IDs de users sin garantizar que el usuario exista
-- en nuestra base: author_ids en audits pueden apuntar a agentes, cuentas
-- system, o users borrados. requester/assignee pueden referirse a users
-- desactivados. Para el espejo 1:1 replicamos ese comportamiento: las
-- columnas quedan como IDs lógicos (BIGINT) sin enforcement de FK hacia
-- support.users.
--
-- Se conservan las FKs internas (audit→ticket, event→audit, identity→user)
-- porque ahí sí tiene sentido la integridad referencial.

ALTER TABLE support.ticket_audits
  DROP CONSTRAINT IF EXISTS ticket_audits_author_id_fkey;

ALTER TABLE support.tickets
  DROP CONSTRAINT IF EXISTS tickets_requester_id_fkey;

ALTER TABLE support.tickets
  DROP CONSTRAINT IF EXISTS tickets_assignee_id_fkey;
