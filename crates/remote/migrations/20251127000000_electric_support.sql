CREATE ROLE electric_sync WITH LOGIN REPLICATION;

-- Grant CONNECT on whatever database this migration runs in, rather than a
-- hardcoded name. Self-hosters (and Coolify's default "postgres" database) may
-- not use a database literally named "remote".
DO $$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO electric_sync', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO electric_sync;

CREATE PUBLICATION electric_publication_default;

CREATE OR REPLACE FUNCTION electric_sync_table(p_schema text, p_table text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    qualified text := format('%I.%I', p_schema, p_table);
BEGIN
    EXECUTE format('ALTER TABLE %s REPLICA IDENTITY FULL', qualified);
    EXECUTE format('GRANT SELECT ON TABLE %s TO electric_sync', qualified);
    EXECUTE format('ALTER PUBLICATION %I ADD TABLE %s', 'electric_publication_default', qualified);
END;
$$;

SELECT electric_sync_table('public', 'shared_tasks');
