\set ON_ERROR_STOP on
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', current_schema());
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO accounts_runtime, hearts_runtime, euchre_runtime', current_schema());
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, account_sessions, password_reset_tokens, account_deletion_requests, account_id_sequence, account_turn_sound_options TO accounts_runtime;
GRANT SELECT ON cards_accounts_alembic_version TO accounts_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON active_games, user_stats, user_preferences, difficulty_stats, game_results, hearts_account_deletions TO hearts_runtime;
GRANT SELECT ON hearts_alembic_version, hearts_account_schema_version TO hearts_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON euchre_tables, euchre_game_results, euchre_account_deletions TO euchre_runtime;
DO $$ BEGIN
  IF to_regclass('euchre_achievement_state') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON euchre_achievement_state TO euchre_runtime;
  END IF;
END $$;
GRANT SELECT ON euchre_alembic_version, euchre_account_schema_version TO euchre_runtime;

DO $$
DECLARE item record; sequence_name text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('accounts_runtime', 'users'), ('accounts_runtime', 'password_reset_tokens'), ('accounts_runtime', 'account_id_sequence'),
    ('hearts_runtime', 'active_games'), ('hearts_runtime', 'user_stats'), ('hearts_runtime', 'user_preferences'), ('hearts_runtime', 'difficulty_stats'), ('hearts_runtime', 'game_results'),
    ('euchre_runtime', 'euchre_game_results')
  ) AS owned(role_name, table_name)
  LOOP
    sequence_name := pg_get_serial_sequence(item.table_name, 'id');
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', sequence_name, item.role_name);
    END IF;
  END LOOP;
END $$;
